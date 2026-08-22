import type { ReactNode, VideoHTMLAttributes } from "react";
import type { StreamKey } from "@xorgate/sdk";
import type { UseReplayPlayer } from "./use-replay-player.js";

export interface ReplayVideoProps
  extends Omit<VideoHTMLAttributes<HTMLVideoElement>, "src" | "srcObject" | "ref"> {
  player: UseReplayPlayer;
  streamKey: StreamKey;
}

/**
 * `laneVideoRef` plus the `<video>` element. Same minimalism as `LiveVideo`:
 * no chrome, no gap overlay, no loading state. Read
 * `player.laneState(streamKey)` and render those yourself.
 */
export function ReplayVideo(props: ReplayVideoProps): ReactNode {
  const { player, streamKey, ...videoProps } = props;
  return <video ref={player.laneVideoRef(streamKey)} playsInline muted {...videoProps} />;
}
