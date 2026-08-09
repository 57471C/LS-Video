# LS.Video — AGENT_MAP

Living map for agents and humans. Read this before large refactors. Update when architecture changes.

**Product:** LS.Video (Lean Studio)  
**Repo:** https://github.com/57471C/LS-Video (legacy clone paths may still say TMVideo)  
**Stack:** Tauri 2 + Rust backend + vanilla JS frontend (no React)  
**Current version:** 0.6.2

---

## Repo layout

| Path | Role |
|------|------|
| `ui/app.js` | Monolith frontend: load path, view modes, markers, queue joins, batch export, CC |
| `ui/state.js` | Project state, localStorage, CSV export helpers |
| `ui/utils.js` | Logging, time format, sanitize — **no** Failsafe Proxy |
| `ui/ui-components.js` | Markers table, footer (Generate CC, clip summary), clip-bound sync hooks |
| `ui/js/timeline-engine.js` | Playhead, ruler, waveform, marker shading, **timeline zoom** |
| `ui/js/viewport-engine.js` | Zoom / pan viewport |
| `ui/js/visualizer-engine.js` | Butterchurn / Web Audio viz |
| `ui/vendor/butterchurn*.js` | Vendored UMD Butterchurn + presets |
| `ui/index.html` | Shell, CSP meta, script order, detailed timeline chrome |
| `ui/styles.css` | View-mode, sequence rows, CC button states, timeline zoom scroll |
| `src-tauri/src/lib.rs` | Proxy, thumbs, project zip, ffmpeg export/join, VTT, proxy cleanup |
| `src-tauri/tauri.conf.json` | productName, identifier, associations, externalBin |
| `src-tauri/capabilities/default.json` | Permissions (fs, shell spawn/open) |
| `src-tauri/binaries/` | ffmpeg sidecar (gitignored; required for build) |
| `LICENSE` | MIT for app source; §2 GPL notice for bundled FFmpeg/x264 sidecar |

---

## Critical globals (ES module + classic scripts)

`app.js` is an ES module. Classic handlers and timeline code need **window** exposure:

- `window.player`, `window.playerReady`
- `window.loadVideo`, `window.cycleViewMode`
- Marker handlers: `jumpToMarkerTime`, `playFromMarkerTime`, `deleteMarker`, `updateMarkerName`, …
- `window.updateMarkersList`, `window.updateVideoTimeSummary`
- Join / sequence: `getActiveJoinRun`, `isActiveRunMulti`, `seekSequenceTime`, `sourceTimeToSequence`, `scheduleJoinTimelineRebuild`, `syncClipBoundsFromMarkers`, `canJoinQueueIndices`, `normalizeInvalidJoins`, `toggleJoinedToNext`
- Media kind / pickers: `isAudioOnlyMedia`, `isVideoMedia`, `getMediaKindForPath`, `getQueueMediaKind`, `getOpenMediaDialogFilters` (empty → audio+video; audio-only queue → audio filters; video present → video only)
- Title bar queue: `hasProjectMediaLoaded`, `updateTitlebarQueueControls` (`+` muted until media loaded; playlist badge count)
- Timeline zoom: `applyTimelineZoomLayout`, `setTimelineZoom`, `getTimelineContentWidth`, `initTimelineZoomControls`
- Timeline marker drag: handles on `#timeline-marker-overlay` (ew-resize); write-back via `writeMarkerLocalTime` / sort + `updateMarkersListImmediate` on drop; clamp non-bound markers to clipIn..clipOut; in/out use Set Clip In/Out bounds over full media
- CC: `setCcButtonState`, `clearSubtitleTracks`, `loadSubtitleTrack`, `triggerVttGeneration`, `buildWebVttFromCues`
- Batch export: `buildBatchJobsFromQueue`, `renderBatchExportList`, `writeBatchExportSidecarVtt`, `humanizeExportError`, `jobHasMixedMedia` (soft `.vtt` next to each job output; failure never fails the video job)
- Dialogs: `asyncConfirm` / `asyncPrompt` (`ui-modals.js`) — opts `confirmLabel`, `cancelLabel`, `danger`, `focusCancel`; Esc cancels
- Clip-edge fades: `setVideoFadeSec`, `getVideoFadeSeconds`, `clampFadeSec`, `formatFadeBadge`, `computeClipEdgeFadeGain`, `fadeOutEarlyBlackSec`, `applyClipEdgeFadePreview`, `paintClipFadeZonesOnHost` / `refreshClipFadeTimelineZones`. `FADE_DEFAULT_SEC = 0`, hard max 10s (also half clip). UX is **marker type menu** (Set Clip In / Out + `#.#s` like Loop); badge on in/out **row**. Live preview ramps opacity/volume and reaches solid black slightly **before** clipOut (export parity). Detailed timeline shows purple fade zones.
- Speed markers: type `speed` + `speedValue` (0.25–4). Badge `1.5x` (no orange tint at exactly 1×). Helpers: `getActiveSpeedMarker`, `buildSpeedRanges`, `applyActiveSpeedPlayback`, `sourceTimeToEffective`, `effectiveTimeToSource`, `scheduleSpeedTimelineRebuild`, `layoutSpeedWarpedFilmstrip` / `layoutSpeedWarpedWaveform`. Live `playbackRate`; slider snaps to active range and drag updates that marker’s rate. Detailed timeline is **output-time** warped (∫ dt/rate) over **full media length** (clipIn/Out do not shrink the ruler). Export: `speed_ranges` on `VideoSegment` → setpts + chained atempo, then edge fades on output time.

If something “does nothing” in the markers table, check window exports first.

---

## Video load path (single pipeline)

**All** user-facing loads go through `window.loadVideo`:

- Load button / dialog
- Drag-drop
- Queue switch
- Project import / `.lsvz` extract
- Startup rehydrate (Normal mode only)
- OS launch args

**Never** assign `video.src` from random call sites. Do **not** reintroduce Failsafe Proxy (prototype interception on `HTMLMediaElement`).

Flow:

1. Normalize path (UNC-safe — see ARCHITECTURE_NUANCES)
2. `invoke("verify_and_prepare_video")` → original or proxy path
3. `convertFileSrc` → `video.src`
4. Subtitles / markers / timeline boot as needed

Flags: `window._videoLoadInProgress` suppresses empty-src MediaError toasts during transitions.

---

## View modes

| Mode | Body class | Boot / behavior |
|------|------------|-----------------|
| **Normal** | `normal-mode` | Cold start (Start Menu / desktop). Editor, sidebars, markers, filmstrip. localStorage video rehydrate **only** here. |
| **Cinema** | `cinema-mode` | Fullscreen review. **Esc → Miniplayer** (not Normal). |
| **Miniplayer** | `miniplayer-mode` | Compact, always-on-top. OS **raw media** launch lands here. |

`cycleViewMode(target)` — use explicit target strings; respect `_viewModeTransitioning` lock.

Theme: respect `localStorage` darkMode / `html.dark` in **all** modes. Cinema/miniplayer stage background is forced black to avoid light-mode chrome gaps.

---

## Proxy (`verify_and_prepare_video`)

| Input | Action |
|-------|--------|
| Audio-only (`mp3`, `wav`, `flac`, `aac`, `m4a`, `ogg`, …) | Return path as-is — **no** proxy |
| HEVC / h265 / hev1 / hvc1 | Proxy → H.264 MP4 cache |
| Unsafe containers (`avi`, `mkv`, `wmv`, `flv`) | Proxy |
| No web-safe video line (no h264/avc1/vp8/vp9/av1) e.g. mpeg4 | Proxy |
| Web-safe H.264 MP4 etc. | Return original |

Cache under app local data (`com.leanstudio.lsvideo`). Overlay: heavy “Optimizing…” only when transcode needed.

Queue items may store `proxyPath` when playback uses a cache file. On remove/replace: `delete_proxy_for_video` + clear Proxy Info UI. Do not leave stale CC tracks across media change (`clearSubtitleTracks`).

---

## Projects & formats

| Format | Use |
|--------|-----|
| `.lsv` / `.lsvz` | Primary project / packaged project |
| `.tmv` / `.tmvz` | Legacy — still open |

localStorage: `lfvideo_project` (current). `timeStudyData` = legacy migrate-once key only.

Rust command names may still say `load_tspz_bundle` / `save_tspz_bundle` — internal; rename later if desired.

---

## Queue, joins, sequence timeline

- `joinedToNext` on item `i` joins `i` → `i+1` (list order).
- **Join class rule:** only **audio+audio** or **video+video**. Audio+video (either order) is blocked (`canJoinQueueIndices` → toast “Can't join audio and video.”; join chip disabled). `normalizeInvalidJoins()` clears illegal flags on load / reorder / sidebar render.
- **Active join run:** contiguous chain containing `activeQueueIndex` (same-class only after normalize).
- Sequence math: `offset(0)=0`, `duration(i)=max(0, clipOut−clipIn)` (speed-warped when ranges exist), `offset(i+1)=offset(i)+duration(i)` so clip N’s sequence out meets clip N+1’s in (flush boundary).
- `syncClipBoundsFromMarkers` keeps `clipInTime`/`clipOutTime` aligned with in/out markers; join rebuild after bound changes.
- Multi-clip detailed timeline: one row per segment; full-source filmstrip/waveform with **tint outside clipIn/Out**; playhead/ruler in sequence time.
- Solo detailed timeline: **full media length** (0..mediaDuration), speed-warped only — clipIn/Out are grey bounds + stop, not timeline length.
- Transport seek bar: multi = sequence `0..total`; solo = local media + clip grey tails.
- **Playback stop:** solo / last-in-run pause at effective clipOut (`enforceClipOutStopOrHandoff`); middle joined clips hand off.

### File pickers (queue media kind)

| Queue state | Open / “+” dialog filters |
|-------------|---------------------------|
| Empty (no paths) | Media = video + audio common types |
| All loaded items audio | Audio only |
| Any video present | Video only (no mixed playlist via picker) |

Helpers: `getQueueMediaKind()`, `getOpenMediaDialogFilters()`. Title-bar **+** stays muted until first media is loaded (`hasProjectMediaLoaded`).

---

## Markers & closed captions

- Types include standard, jump, loop, in, out, **speed**.
- **Speed** (`type: "speed"`, `speedValue` 0.25–4): holds rate from that marker’s time until the next speed marker (or clip out). Non-1× zones get orange timeline tint; **1× does not**. Badge on the speed marker row (`1.5x`).
- Clip-edge fade is **not** a marker type — it is set on **in/out** rows via the type menu (same pattern as Loop count).
- **Generate CC** (table footer): plain WebVTT from markers (solo = active source; multi = sequence-ordered run); save beside video + load track.
- CC transport button states (`setCcButtonState`): **none** (dark/disabled), **available** (white/idle), **active** (green glow).

---

## Timeline / filmstrip / zoom

- Custom canvas waveform + filmstrip (Peaks.js / Whisper **removed** — do not re-add).
- Stale-job guard: `window._timelineGenId` + request path check on async completion.
- Per-video thumbnail cache dir in Rust.
- **Skip** filmstrip/thumb generation for audio-only files.
- **Detailed timeline zoom** (`#timelineZoomSlider`): factor `1` = fit width; `>1` = `fitWidth * zoom` + horizontal scroll on `#timeline-h-scroll` (ruler + tracks share scrollLeft). Debounce filmstrip regen on slider change.
- **Speed-warped timeline (solo detailed):** ruler, playhead, scrub, filmstrip cells, and waveform use **output time** (`∫ dt / rate` over **full media** 0..mediaDuration — not the clipIn..clipOut window). Source→effective / effective→source via `sourceTimeToEffective` / `effectiveTimeToSource` + `buildSpeedRanges`. Filmstrip/waveform cells sized by `outSpan = sourceSpan / rate`. Call `scheduleSpeedTimelineRebuild` after speed/marker/clip edits. Join multi-clip sequence offsets still use per-segment clip spans; speed warp applies inside each solo layout path when ranges exist.
- **Marker drag (detailed overlay):** horizontal drag on stem/flag handles; live table + paint; persist on mouseup (`updateMarkersListImmediate`). End/out handles stay grabable at the right edge (not clipped at 100%).
- Purple **clip-edge fade zones** on the detailed host: fade-in over `[clipIn, clipIn+fi)`; fade-out ramps to solid black slightly **before** clipOut (`fadeOutEarlyBlackSec`, export parity).

---

## Batch export (queue)

Entry: settings panel → Batch export queue (**checked by default**) + optional Strip audio.

| Job type | Output |
|----------|--------|
| Contiguous same-class `joinedToNext` run | One concat (video → `.mp4`; **audio-only → `.m4a`**) + optional soft `.vtt` for video jobs |
| Unjoined item | Solo trim/export + optional soft `.vtt` |

- Folder pick once; names like `sequence_001_…mp4` / `basename_export.mp4` (or `.m4a` for audio).
- **Mixed audio+video joins never export:** cleared by `normalizeInvalidJoins` / `canJoinQueueIndices`; `export_queue_job` rejects mixed segment lists; UI toasts short human text via `humanizeExportError` (never dump full ffmpeg logs as the only feedback).
- Soft captions sidecar (no burn-in): same basename as the video, `.vtt`, same folder.
  - **Solo:** markers (or existing source VTT) with times relative to export trim (`clipIn → 0`).
  - **Join:** all markers in the run, sequence-shifted by sum of prior segment durations; cue text = marker name; end = next cue / +3s / clip end (same policy as Generate CC).
  - Skip when no markers and no source VTT; **VTT write failure never fails the video job** (toast warning OK).
- Clip-edge fades (soft export filters only):
  - Per queue item: `fadeInSec` / `fadeOutSec` (default **0**).
  - UX (same family as Loop): marker row type menu → **Set Clip In** / **Set Clip Out** with `#.#s` duration input (UI placeholder may show `1.0`; stored default is `0`; `0` clears). Cyan badge on the in/out **marker row** when fade > 0. **No** footer Fade button; **no** playlist fade UI.
  - Live preview: opacity + volume ramp via `computeClipEdgeFadeGain` / `applyClipEdgeFadePreview`; fade-out hits solid black slightly before clipOut.
  - Export: ffmpeg `fade` / `afade` on **output** segment time after speed; join keeps per-segment fades; `0` → no filter. Forces reencode when fade > 0. **Audio-only:** video fade filters skipped (`-vn`); `afade` only.
- Speed markers (export):
  - Frontend builds `speed_ranges: [{ start, end, rate }, …]` covering `[clipIn, clipOut]` via `buildSpeedRanges` (gaps default rate 1).
  - Per range: `setpts=(PTS-STARTPTS)/rate` + chained `atempo` (ffmpeg 0.5–2 per stage); `-t` caps piece length at `span/rate`.
  - Pieces concat’d then fade applied on that output timeline. 1×-only ranges can skip speed filter when whole segment is flat 1×.
- Rust: `export_queue_job` pipeline order: **trim → speed pieces → concat pieces → edge fade → quality**. Audio-only segments: no libx264 / no `-vf`; AAC/`-vn`. Also `save_vtt_file` for sidecar write.
- **IPC `VideoSegment`:** send **one** of `loop_count` / `loopCount`, never both (serde duplicate field). Fade: `fade_in_sec` / `fade_out_sec` (aliases `fadeInSec` / `fadeOutSec`). Speed: `speed_ranges` array of `{ start, end, rate }` (snake_case preferred). Optional `audio_only` / `audioOnly` flag.
- Also: `join_and_compress_videos` (legacy single-shot join UI path).
- Out of scope for batch captions: burn-in, ASS/SSA styling, titles.

---

## Butterchurn (audio viz)

- Vendor scripts in `ui/vendor/`; CSP needs `script-src 'self' 'unsafe-eval'` (preset `new Function`).
- `MediaElementSource` **once** per `<video>` lifetime; connect so audio still reaches speakers.
- Size canvas from **container**, not `videoWidth` (audio has no intrinsic size).
- Viz toggle: **audio-only only**. Video load → stop viz, hide/disable button, restore video opacity.
- Hide trim/compress camera control in miniplayer + cinema.

---

## Shell / links

`shell:allow-open` allow-list for lean.studio, speeddf, buymeacoffee. ffmpeg via `shell:allow-spawn` sidecar only.

---

## Git / agent workflow (owner preference)

- New work on a **branch** from latest `main`
- **PR into main**; delete **local** branch only after merge
- Provide **copy-paste commit messages**
- Do not `git add` `ui/tailwind.css` / accidental `Cargo.toml` noise — `git restore` them
- Branch **off main**, not off unmerged feature branches, unless the fix depends on that feature

---

## Out of scope / dead ends

- Peaks.js, Whisper, Failsafe Proxy
- VLC / libmpv experimental branches (orphaned; proxy is the supported H.265 path)
- Shipping without ffmpeg sidecar in the NSIS bundle
- Batch export: titles, burn-in captions, dip-to-black as a separate fade **mode**, fancy re-encode UI beyond quality presets
- Mixed audio+video playlists via the file picker once a video is present (policy: video filter only)
- (Done, do not re-litigate:) soft VTT sidecars, clip-edge fades + live preview, Speed markers + export + speed-warped solo timeline, audio queue pickers/join guards, detailed timeline marker drag, full-media solo timeline length

---

## Related docs

- `ARCHITECTURE_NUANCES.md` — footguns and “why it is this way”
- `README.md` — user-facing overview
