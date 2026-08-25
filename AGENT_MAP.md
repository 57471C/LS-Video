# LS.Video — AGENT_MAP

Living map for agents and humans. Read this before large refactors. Update when architecture changes.

**Product:** LS.Video (Lean Studio)  
**Repo:** https://github.com/57471C/LS-Video (legacy clone paths may still say TMVideo)  
**Stack:** Tauri 2 + Rust backend + vanilla JS frontend (no React)  
**Current version:** 0.6.7

---

## Repo layout

| Path | Role |
|------|------|
| `ui/app.js` | Monolith frontend: load path, view modes, markers, queue joins, batch export, CC, audio model |
| `ui/state.js` | Project state, localStorage, CSV export helpers |
| `ui/utils.js` | Logging, time format, sanitize — **no** Failsafe Proxy |
| `ui/ui-components.js` | Markers table, footer (Generate CC, clip summary), clip-bound sync hooks |
| `ui/js/timeline-engine.js` | Playhead, ruler, waveform, marker shading, **timeline zoom layout & settle debounce** |
| `ui/js/viewport-engine.js` | Zoom / pan viewport |
| `ui/js/visualizer-engine.js` | Butterchurn / Web Audio viz |
| `ui/js/path-to-asset-url.js` | Filesystem path → WebView `asset:` URL (quiet by default; debug flag) |
| `ui/js/updater.js` | Auto-update toast (Cancel / Now / When I close); boots from `index.html` |
| `ui/vendor/butterchurn*.js` | Vendored UMD Butterchurn + presets |
| `ui/index.html` | Shell, CSP meta, script order, detailed timeline chrome, DAW fader gutters |
| `ui/styles.css` | View-mode, sequence rows, CC button states, timeline zoom scroll, centered miniplayer transport |
| `src-tauri/src/lib.rs` | Proxy, thumbs, project zip, ffmpeg export/join, VTT, proxy cleanup, **in-memory verify probe cache** |
| `src-tauri/tauri.conf.json` | productName, identifier, associations, externalBin, updater pubkey/endpoints |
| `src-tauri/capabilities/default.json` | Permissions (fs, shell spawn/open, updater) |
| `src-tauri/binaries/` | ffmpeg sidecar (gitignored; required for build) |
| `LICENSE` | MIT for app source; §2 GPL notice for bundled FFmpeg/x264 sidecar |

---

## Critical globals (ES module + classic scripts)

`app.js` is an ES module. Classic handlers and timeline code need **window** exposure:

- `window.player`, `window.playerReady`
- `window.loadVideo`, `window.cycleViewMode`
- Miniplayer sizing: `getSavedMiniplayerSize`, `saveMiniplayerSize`, `getCurrentLogicalWindowSize`
- Audio model: `applyEffectivePlaybackVolume`, `getClipVolumeForQueueIndex`, `setClipVolumeForQueueIndex`, `syncClipFaderGutter`
- Path / asset URL: `normalizePath`, `pathToAssetUrl` (module `ui/js/path-to-asset-url.js`; filesystem → WebView `asset:` URL; debug gate `localStorage.lsvideo_debug_paths = "1"`)
- Updater: `window.initUpdater`, `window.checkForUpdatesNow` (`ui/js/updater.js`)
- Marker handlers: `jumpToMarkerTime`, `playFromMarkerTime`, `deleteMarker`, `updateMarkerName`, …
- `window.updateMarkersList`, `window.updateVideoTimeSummary`
- Join / sequence: `getActiveJoinRun`, `isActiveRunMulti`, `seekSequenceTime`, `sourceTimeToSequence`, `scheduleJoinTimelineRebuild`, `syncClipBoundsFromMarkers`, `canJoinQueueIndices`, `normalizeInvalidJoins`, `toggleJoinedToNext`
- Media kind / pickers: `isAudioOnlyMedia`, `isVideoMedia`, `getMediaKindForPath`, `getQueueMediaKind`, `getOpenMediaDialogFilters` (empty → audio+video; audio-only queue → audio filters; video present → video only)
- Title bar queue: `hasProjectMediaLoaded`, `updateTitlebarQueueControls` (`+` muted until media loaded; playlist badge count)
- Timeline zoom: `applyTimelineZoomLayout`, `setTimelineZoom`, `resetTimelineZoomToFit`, `scheduleTimelineZoomSettle`, `getTimelineContentWidth`, `initTimelineZoomControls`
- Timeline marker drag: handles on `#timeline-marker-overlay` (ew-resize); write-back via `writeMarkerLocalTime` / sort + `updateMarkersListImmediate` on drop; clamp non-bound markers to clipIn..clipOut; in/out use Set Clip In/Out bounds over full media
- CC: `setCcButtonState`, `clearSubtitleTracks`, `loadSubtitleTrack`, `triggerVttGeneration`, `buildWebVttFromCues`
- Batch export: `buildBatchJobsFromQueue`, `renderBatchExportList`, `writeBatchExportSidecarVtt`, `humanizeExportError`, `jobHasMixedMedia` (soft `.vtt` next to each job output; failure never fails the video job)
- Dialogs: `asyncConfirm` / `asyncPrompt` (`ui-modals.js`) — opts `confirmLabel`, `cancelLabel`, `danger`, `focusCancel`; Esc cancels
- Clip-edge fades: `setVideoFadeSec`, `getVideoFadeSeconds`, `clampFadeSec`, `formatFadeBadge`, `computeClipEdgeFadeGain`, `fadeOutEarlyBlackSec`, `applyClipEdgeFadePreview`, `paintClipFadeZonesOnHost` / `refreshClipFadeTimelineZones`. `FADE_DEFAULT_SEC = 0`, hard max 10s (also half clip). UX is **marker type menu** (Set Clip In / Out + `#.#s` like Loop); badge on in/out **row**. Live preview ramps opacity/volume and reaches solid black slightly **before** clipOut (export parity). Detailed timeline shows purple fade zones.
- Speed markers: type `speed` + `speedValue` (0.25–8). Badge `1.5x` (no orange tint at exactly 1×). Keys 1–8 set 1×–8× (backtick = 0.5×). Helpers: `getActiveSpeedMarker`, `buildSpeedRanges`, `applyActiveSpeedPlayback`, `sourceTimeToEffective`, `effectiveTimeToSource`, `scheduleSpeedTimelineRebuild`, `layoutSpeedWarpedFilmstrip` / `layoutSpeedWarpedWaveform`. Live `playbackRate`; slider snaps to active range and drag updates that marker’s rate. Detailed timeline is **output-time** warped (∫ dt/rate) over **full media length** (clipIn/Out do not shrink the ruler). Export: `speed_ranges` on `VideoSegment` → setpts + chained atempo, then edge fades on output time.

If something “does nothing” in the markers table, check window exports first.

---

## Video load path & probe caching

**All** user-facing loads go through `window.loadVideo`:

- Load button / dialog
- Drag-drop
- Queue switch / soft handoff
- Project import / `.lsvz` extract
- Startup rehydrate (Normal mode only)
- OS launch args

**Never** assign `video.src` from random call sites. Do **not** reintroduce Failsafe Proxy (prototype interception on `HTMLMediaElement`). Filesystem paths → `src` go through `pathToAssetUrl` (never raw `convertFileSrc` / `encodeURIComponent` at the call site).

Flow:

1. Normalize path (UNC-safe — see ARCHITECTURE_NUANCES)
2. `invoke("verify_and_prepare_video")` → process-lifetime cache check in Rust (`VERIFY_CACHE`), FFmpeg probe if missed → returns original or proxy path
3. `pathToAssetUrl` (prefers Tauri `convertFileSrc`; platform fallback; quiet by default) → `video.src`
4. Subtitles / markers / timeline boot as needed (`isSoftHandoffLoad` skips visual wipe / full strip rebuild)

Same helper for other disk-backed asset URLs: caption `track.src`, filmstrip `img.src`, export fallback `player.src`. Leave blob / HTTP / empty-src assignments alone.

Flags: `window._videoLoadInProgress` suppresses empty-src MediaError toasts during transitions. `window._skipNextTimelineBoot` suppresses timeline visual wipes on soft handoffs.

---

## View modes & miniplayer sizing

| Mode | Body class cues | Notes |
|------|-----------------|-------|
| **Normal** | default | Cold start; full editor; localStorage rehydrate; maximized window |
| **Cinema** | `cinema-active` | Immersive fullscreen; **Esc → Miniplayer** (not Normal) |
| **Miniplayer** | `miniplayer-mode` | Compact, always-on-top; user-resizable with size persisted in `localStorage` (`lsvideo_miniplayer_w`/`h`, min `320×200`, default `580×524`); transport icons centered. OS **raw media** launch lands here. |

`cycleViewMode(target)` — use explicit target strings; respect `_viewModeTransitioning` lock. Persists miniplayer size on mode exit; restores on mode enter.

Theme: respect `localStorage` darkMode / `html.dark` in **all** modes. Cinema/miniplayer stage background is forced black to avoid light-mode chrome gaps.

---

## Proxy (`verify_and_prepare_video`)

| Input | Action |
|-------|--------|
| Audio-only (`mp3`, `wav`, `flac`, `aac`, `m4a`, `ogg`, …) | Return path as-is — **no** proxy (cached) |
| HEVC / h265 / hev1 / hvc1 | Proxy → H.264 MP4 cache (**default**; see experiment note; cached) |
| Unsafe containers (`avi`, `mkv`, `wmv`, `flv`) | Proxy (cached) |
| No web-safe video line (no h264/avc1/vp8/vp9/av1) e.g. mpeg4 | Proxy (cached) |
| Web-safe H.264 MP4 etc. | Return original (cached) |

Cache under app local data (`com.leanstudio.lsvideo`). In-memory `VERIFY_CACHE` prevents repeat FFmpeg sidecar probes during segment switches. Overlay: heavy “Optimizing…” only when transcode needed.

Queue items may store `proxyPath` when playback uses a cache file. On remove/replace: `delete_proxy_for_video` (clears in-memory cache entry) + clear Proxy Info UI. Do not leave stale CC tracks across media change (`clearSubtitleTracks`).

### H.265 / HEVC (current law + experiment)

**Supported path today:** always proxy HEVC → H.264 MP4 via the static ffmpeg sidecar. WebView2 (Windows) and WKWebView (macOS) are treated as unreliable for in-app HEVC without platform codecs / entitlement variance. Do **not** remove the proxy path.

**Experiment (optional, branch-only):** try native `<video>` playback for `hev1`/`hvc1` on **macOS only**, fall back to proxy on `error` / non-zero `MediaError`. Windows stays proxy-first unless HEVC Video Extensions are proven in WebView2. Goals: skip “Optimizing…” when the OS can decode; measure seek/scrub parity vs proxy. Document results in ARCHITECTURE_NUANCES before merging any try-native change.

Proxy ffmpeg must be **fully static on macOS** (no Homebrew libx264 dylib) or signed apps die on dyld Team ID mismatch.

---

## Projects & formats

| Format | Use |
|--------|-----|
| `.lsv` / `.lsvz` | Primary project / packaged project |
| `.tmv` / `.tmvz` | Legacy — still open |

localStorage: `lfvideo_project` (current). `timeStudyData` = legacy migrate-once key only.

Rust command names may still say `load_tspz_bundle` / `save_tspz_bundle` — internal; rename later if desired.

---

## Queue, joins, sequence timeline & audio model

- `joinedToNext` on item `i` joins `i` → `i+1` (list order).
- **Join class rule:** only **audio+audio** or **video+video**. Audio+video (either order) is blocked (`canJoinQueueIndices` → toast “Can't join audio and video.”; join chip disabled). `normalizeInvalidJoins()` clears illegal flags on load / reorder / sidebar render.
- **Active join run:** contiguous chain containing `activeQueueIndex` (same-class only after normalize).
- Sequence math: `offset(0)=0`, `duration(i)=max(0, clipOut−clipIn)` (speed-warped when ranges exist), `offset(i+1)=offset(i)+duration(i)` so clip N’s sequence out meets clip N+1’s in (flush boundary).
- `syncClipBoundsFromMarkers` keeps `clipInTime`/`clipOutTime` aligned with in/out markers; join rebuild after bound changes.
- **DAW Clip Audio Model:** Master volume (`masterVolumeLevel`, `masterMuted`) is a monitoring output level; per-clip gain (`clipVolumePercent` 0–200%, default 100%) is stored on each queue item and rendered via left DAW fader gutters on detailed timeline track rows (`.timeline-clip-fader-gutter`).
- Multi-clip detailed timeline: one row per segment with left fader gutter + tracks stack; full-source filmstrip/waveform with **tint outside clipIn/Out**; playhead/ruler in sequence time.
- Solo detailed timeline: **full media length** (0..mediaDuration), speed-warped only — clipIn/Out are grey bounds + stop, not timeline length.
- Transport seek bar: multi = sequence `0..total`; solo = local media + clip grey tails.
- **Playback stop:** solo / last-in-run pause at effective clipOut (`enforceClipOutStopOrHandoff`); middle joined clips hand off.
- **App Shell Scroll:** `.app-master-container` scrolls vertically so multi-track detailed timelines are fully reachable without unseating `#markersList` internal scrollers.

### File pickers (queue media kind)

See ARCHITECTURE_NUANCES §20. Empty queue → audio+video filters; after audio-only → audio only; any video present → video only.

---

## Markers & closed captions

- Types include standard, jump, loop, in, out, **speed**.
- **Speed** (`type: "speed"`, `speedValue` 0.25–8): holds rate from that marker’s time until the next speed marker (or clip out). Non-1× zones get orange timeline tint; **1× does not**. Badge on the speed marker row (`1.5x`).
- Clip-edge fade is **not** a marker type — it is set on **in/out** rows via the type menu (same pattern as Loop count).
- **Generate CC** (table footer): plain WebVTT from markers (solo = active source; multi = sequence-ordered run); save beside video + load track.
- CC transport button states (`setCcButtonState`): **none** (dark/disabled), **available** (white/idle), **active** (green glow).

---

## Timeline / filmstrip / zoom

Custom canvas filmstrip + waveform (Peaks.js removed). Skip filmstrip generation for audio-only. Generation tokens avoid stale thumbs after rapid queue switches.

- Timeline zoom is **detailed panel only** — not the transport seek bar.
- **Live zoom scaling:** Zoom slider dragging immediately stretches layout via CSS width without rebuilding tracks.
- **Deferred settle regeneration:** Pausing zoom for 400ms (`scheduleTimelineZoomSettle`) triggers a single background regeneration (`loadWaveformTimeline()`) to sharpen thumbnails.
- **In-place preservation:** Existing track rows and segment shells in DOM are preserved during settle regen, seamlessly replacing tiles upon arrival without blanking or placeholder flicker.

---

## Batch export (queue)

`buildBatchJobsFromQueue` → IPC `export_queue_job` per job. Join runs export as one file when joined; others separate. Per-clip volume gain (0–200%) passed to export. Strip-audio option. Soft VTT sidecars never fail the video job. `humanizeExportError` for toasts — not raw multi-kB ffmpeg stderr.

---

## Butterchurn (audio viz)

Audio-only only. CSP needs `script-src 'unsafe-eval'` for Butterchurn. Source map 404/parse noise is cosmetic (strip or ignore).

---

## Auto-update

- Feed: `https://lean.studio/lsvideo/latest.json` (site proxies GitHub Release asset `latest.json`)
- Config: `plugins.updater` pubkey + endpoints in `tauri.conf.json`; `createUpdaterArtifacts: true`
- Plugins: `tauri-plugin-updater` + `tauri-plugin-process` (registered in `lib.rs`)
- Secrets: `TAURI_SIGNING_PRIVATE_KEY` (+ password if set); never commit `*.key`
- UX (`ui/js/updater.js`, speedDF model): silent `check()` ~2.5s after load → toast **Cancel** | **Now** | **When I close**
  - Now → `downloadAndInstall` + `relaunch`
  - When I close → background `download`, `install` on `onCloseRequested`
  - Optional skip: `localStorage.lsvideo_check_updates_on_launch = "0"`
  - Manual: `window.checkForUpdatesNow()`
- Suite contract: `SUITE_MAP.md` on `lean-studio-web` (repo root, **not** a public route)

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
- Re-tagging a published release (e.g. rewrite `v0.6.5`) — ship the next version instead
- Shipping without ffmpeg sidecar in the NSIS bundle
- Batch export: titles, burn-in captions, dip-to-black as a separate fade **mode**, fancy re-encode UI beyond quality presets
- Mixed audio+video playlists via the file picker once a video is present (policy: video filter only)
- (Done, do not re-litigate:) soft VTT sidecars, clip-edge fades + live preview, Speed markers + export + speed-warped solo timeline, audio queue pickers/join guards, detailed timeline marker drag, full-media solo timeline length

---

## Related docs

- `ARCHITECTURE_NUANCES.md` — footguns and “why it is this way”
- `README.md` — user-facing overview
- `SUITE_MAP.md` — Lean.Studio product family + cross-app updater contract (`lean-studio-web` repo root)
