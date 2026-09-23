# Telemetry artifact fixtures

Real objects from the dev bucket, byte-for-byte as S3 serves them (gzipped;
the manifest hands them out with `Content-Encoding: gzip`, so a browser's
`fetch()` sees the inflated body). Tests inflate them with `node:zlib`.

- `overview.v1.golden.json.gz`: overview of telemetry session
  `019fe89f-e9a8-7882-bfb0-aee70ea2b8df` on Toronto Node 01 (the 25 km
  golden drive, 52 segments, 3 153 samples): gps at 5 s / 633 buckets, imu and
  system at 15 s / 213, lte at 1 s / 192, bbox
  `[-79.574472, 43.598321, -79.517906, 43.66587]`, nine v1 insights.
- `overview.v1.small.json.gz`: overview of session
  `01a0cae8-830d-76a0-8320-c9b2bfa556e5` (one 60-sample segment, every group
  at the native 1 s period).
- `1786314223040-00000.jsonl.gz`, `1786317672922-00001.jsonl.gz`,
  `1786317732965-00002.jsonl.gz`: seq 0, 1 and 2 of the golden session. Seq 0
  spans 57 minutes for 60 samples (a recording hole inside one file).
