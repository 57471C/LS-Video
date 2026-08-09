## Features ##
- [x] In the footer row of the Marker table, add a "Generate CC" button that creates the .vtt file based on the existing markers.
- [x] Speed markers + speed-warped solo timeline + export setpts/atempo
- [x] Clip-edge fades (menu + live preview + export); early solid black before clipOut
- [x] Drag markers on the detailed timeline (handles; table updates on drop)
- [x] Audio queue pickers (filters follow audio vs video) + same-class join only

---
## Fixes ##
- [x] When CC's are active make the icon glow green. When off, make it glow leave white (if there's captions available). If there is no vtt file for the video make it look dark/disabled.

- [x] The playlist on the left menu isn't refreshing as videos are added and removed
- [x] The Close Caption display needs to be cleared when the video changes. When a video is deleted, the "Proxy Info" should also be deleted.
- [x] Title-bar + disabled until media loaded; playlist queue toggle discoverability
- [x] Solo detailed timeline length = full media (not clipIn/Out window)
- [x] Mixed audio/video join blocked; batch export human toasts + audio-safe path