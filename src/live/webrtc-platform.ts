import { XorgateError } from "@xorgate/sdk";
import type { ResolvedLiveCredentials } from "./credential-resolver.js";
import type { PeerConnectionLike, SignalingLike, WebRtcPlatform } from "./kvs-session.js";

function toAwsCreds(credentials: ResolvedLiveCredentials): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} {
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
  };
}

/**
 * The real AWS wiring behind the KVS viewer session. Everything here is
 * dynamically imported: a page that mounts no video never loads the KVS or
 * Cognito clients, which are the largest thing in the dependency tree.
 */
export function createWebRtcPlatform(): WebRtcPlatform {
  return {
    async getViewerEndpoints(channelRef, region, credentials) {
      const { KinesisVideoClient, GetSignalingChannelEndpointCommand } = await import(
        "@aws-sdk/client-kinesis-video"
      );
      const kvClient = new KinesisVideoClient({ region, credentials: toAwsCreds(credentials) });
      const res = await kvClient.send(
        new GetSignalingChannelEndpointCommand({
          ChannelARN: channelRef,
          SingleMasterChannelEndpointConfiguration: {
            Protocols: ["WSS", "HTTPS"],
            Role: "VIEWER",
          },
        }),
      );
      const endpoints: Record<string, string> = {};
      for (const e of res.ResourceEndpointList ?? []) {
        if (e.Protocol && e.ResourceEndpoint) endpoints[e.Protocol] = e.ResourceEndpoint;
      }
      if (!endpoints.WSS || !endpoints.HTTPS) {
        throw new XorgateError({
          code: "INVALID_RESPONSE",
          message: "Signaling endpoint list missing WSS/HTTPS.",
        });
      }
      return {
        wss: endpoints.WSS,
        https: endpoints.HTTPS,
        clockOffsetMs: kvClient.config.systemClockOffset,
      };
    },

    async getIceServers(channelRef, region, httpsEndpoint, credentials) {
      const { KinesisVideoSignalingClient, GetIceServerConfigCommand } = await import(
        "@aws-sdk/client-kinesis-video-signaling"
      );
      const client = new KinesisVideoSignalingClient({
        region,
        endpoint: httpsEndpoint,
        credentials: toAwsCreds(credentials),
      });
      const res = await client.send(new GetIceServerConfigCommand({ ChannelARN: channelRef }));
      const iceServers: RTCIceServer[] = [
        { urls: `stun:stun.kinesisvideo.${region}.amazonaws.com:443` },
      ];
      for (const s of res.IceServerList ?? []) {
        if (s.Uris) {
          iceServers.push({ urls: s.Uris, username: s.Username, credential: s.Password });
        }
      }
      return iceServers;
    },

    createSignaling(args): SignalingLike {
      // The signaling client is created lazily inside a facade: the KVS
      // library import is async, but the session wants a synchronous handle.
      // Events registered before the import resolves are replayed onto the
      // real client, and open() waits for it.
      const pending: Array<{ event: string; cb: (...a: never[]) => void }> = [];
      let real: SignalingLike | null = null;
      let opened = false;
      let closed = false;

      const load = (async () => {
        const { Role, SignalingClient } = await import("amazon-kinesis-video-streams-webrtc");
        if (closed) return;
        const client = new SignalingClient({
          channelARN: args.channelRef,
          channelEndpoint: args.wssEndpoint,
          role: Role.VIEWER,
          region: args.region,
          clientId: args.clientId,
          credentials: toAwsCreds(args.credentials),
          ...(args.clockOffsetMs !== undefined ? { systemClockOffset: args.clockOffsetMs } : {}),
        }) as unknown as SignalingLike;
        real = client;
        for (const { event, cb } of pending) client.on(event, cb);
        if (opened && !closed) client.open();
      })();

      return {
        on(event, cb) {
          if (real) real.on(event, cb);
          else pending.push({ event, cb });
        },
        open() {
          opened = true;
          if (real && !closed) real.open();
          void load;
        },
        close() {
          closed = true;
          try {
            real?.close();
          } catch {
            /* already closed */
          }
        },
        sendSdpOffer(offer) {
          real?.sendSdpOffer(offer);
        },
        sendIceCandidate(candidate) {
          real?.sendIceCandidate(candidate);
        },
      };
    },

    createPeerConnection(iceServers): PeerConnectionLike {
      return new RTCPeerConnection({
        iceServers: iceServers as RTCIceServer[],
        iceTransportPolicy: "all",
      }) as unknown as PeerConnectionLike;
    },

    randomId(): string {
      return crypto.randomUUID();
    },
  };
}
