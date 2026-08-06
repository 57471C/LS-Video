# License notes (sidecar)

A build that links **libx264** is **GPL**.

When you ship `ffmpeg.exe` next to LS.Video:

1. Keep the app’s own license (e.g. MIT) clear for *your* code.
2. State that the bundled FFmpeg binary is GPL and that source for that binary is available (FFmpeg + x264 upstream tags you built from, or an offer equivalent to GPL obligations).
3. Do not claim the whole installer is MIT-only if it includes this sidecar.

This project only produces a helper binary; it does not relicense FFmpeg or x264.
