// Minimal MP4 box walker for the replay player: pulls the exact RFC 6381
// codec string (from avcC), the track timescale, and the first fragment's
// tfdt baseMediaDecodeTime out of a fetched fMP4 segment. The manifest is
// deliberately format-neutral (no codec strings), so the player reads these
// from the first segment's bytes instead of hardcoding the device encoder's
// current output.

export interface SegmentMediaInfo {
  /** e.g. "avc1.42C028"; null when no avcC was found (unsupported layout). */
  codec: string | null;
  timescale: number;
  /**
   * First tfdt baseMediaDecodeTime in seconds (segments restart at ~0 per
   * file; subtracting it from timestampOffset guards against future muxer
   * changes).
   */
  firstTfdtSec: number;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "moof", "traf"]);

export function parseSegmentMediaInfo(buf: ArrayBuffer): SegmentMediaInfo {
  const view = new DataView(buf);
  const fourcc = (off: number) =>
    String.fromCharCode(
      view.getUint8(off),
      view.getUint8(off + 1),
      view.getUint8(off + 2),
      view.getUint8(off + 3),
    );

  let codec: string | null = null;
  let timescale = 0;
  let firstTfdt: number | null = null;

  const walk = (start: number, end: number): void => {
    let off = start;
    while (off + 8 <= end) {
      let size = view.getUint32(off);
      const type = fourcc(off + 4);
      let body = off + 8;
      if (size === 1) {
        size = Number(view.getBigUint64(off + 8));
        body = off + 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < 8 || off + size > end) return; // malformed/truncated tail
      if (type === "mdhd" && !timescale) {
        const version = view.getUint8(body);
        timescale = view.getUint32(body + 4 + (version === 1 ? 16 : 8));
      } else if (type === "stsd" && !codec) {
        // Scan the sample entry for avcC and build "avc1." + profile/compat/
        // level hex — validated on real segments.
        for (let b = body; b + 8 <= off + size; b++) {
          if (fourcc(b + 4) === "avcC") {
            const c = b + 8;
            const hex = [1, 2, 3]
              .map((i) => view.getUint8(c + i).toString(16).padStart(2, "0"))
              .join("");
            codec = `avc1.${hex.toUpperCase()}`;
            break;
          }
        }
      } else if (type === "tfdt" && firstTfdt === null) {
        const version = view.getUint8(body);
        firstTfdt =
          version === 1 ? Number(view.getBigUint64(body + 4)) : view.getUint32(body + 4);
      }
      if (CONTAINERS.has(type) && (firstTfdt === null || !codec || !timescale)) {
        walk(body, off + size);
      }
      off += size;
    }
  };

  walk(0, buf.byteLength);
  return {
    codec,
    timescale: timescale || 1,
    firstTfdtSec: (firstTfdt ?? 0) / (timescale || 1),
  };
}
