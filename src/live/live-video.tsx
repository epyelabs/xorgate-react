import { useEffect, useRef } from "react";
import type { ReactNode, VideoHTMLAttributes } from "react";
import type { VideoChannel, XorgateError } from "@xorgate/sdk";
import { useLiveVideo } from "./use-live-video.js";
import type { LiveVideoStatus, UseLiveVideoOptions } from "./use-live-video.js";

export interface LiveVideoProps
  extends Omit<VideoHTMLAttributes<HTMLVideoElement>, "src" | "srcObject" | "ref"> {
  channel: VideoChannel | null;
  options?: UseLiveVideoOptions;
  /** Called on every transition. The component renders no status chrome of its own. */
  onStatusChange?: (status: LiveVideoStatus, error: XorgateError | null) => void;
}

/**
 * `useLiveVideo` plus the `<video>` element, and nothing else: no card, no
 * spinner, no error text, no aspect ratio. It exists so the 90% case is one
 * line, not so it can be your player. `playsInline` and `muted` default to
 * true, because a stream that is neither will not autoplay in Safari.
 */
export function LiveVideo(props: LiveVideoProps): ReactNode {
  const { channel, options, onStatusChange, ...videoProps } = props;
  const { videoRef, status, error } = useLiveVideo(channel, options);

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => {
    onStatusChangeRef.current?.(status, error);
  }, [status, error]);

  return <video ref={videoRef} playsInline muted autoPlay {...videoProps} />;
}
