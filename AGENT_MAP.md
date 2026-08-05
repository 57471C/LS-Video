# LS.Video — AGENT_MAP

Living map for agents and humans. Read this before large refactors. Update when architecture changes.

**Product:** LS.Video (Lean Studio)  
**Repo:** https://github.com/57471C/LS-Video (legacy clone paths may still say TMVideo)  
**Stack:** Tauri 2 + Rust backend + vanilla JS frontend (no React)  
**Current version:** 0.6.1

---

## Repo layout

| Path | Role |
|------|------|
| `ui/app.js` | Monolith frontend: load path, view modes, markers wiring, launch args |
| `ui/state.js` | Project state, localStorage, CSV export helpers |
| `ui/utils.js` | Logging, time format, sanitize — **no** Failsafe Proxy |
| `ui/ui-components.js` | Markers table render / DOM |
| `ui/js/timeline-engine.js` | Playhead, ruler, waveform track drawing |
| `ui/js/viewport-engine.js` | Zoom / pan viewport |
| `ui/js/visualizer-engine.js` | Butterchurn / Web Audio viz |
| `ui/vendor/butterchurn*.js` | Vendored UMD Butterchurn + presets |
| `ui/index.html` | Shell, CSP meta, script order |
| `ui/styles.css` | View-mode and chrome CSS |
| `src-tauri/src/lib.rs` | Commands: proxy, thumbs, project zip, ffmpeg |
| `src-tauri/tauri.conf.json` | productName, identifier, associations, externalBin |
| `src-tauri/capabilities/default.json` | Permissions (fs, shell spawn/open) |
| `src-tauri/binaries/` | ffmpeg sidecar (gitignored; required for build) |

---

## Critical globals (ES module + classic scripts)

`app.js` is an ES module. Classic handlers and timeline code need **window** exposure:

- `window.player`, `window.playerReady`
- `window.loadVideo`, `window.cycleViewMode`
- Marker handlers: `jumpToMarkerTime`, `playFromMarkerTime`, `deleteMarker`, `updateMarkerName`, …
- `window.updateMarkersList`, `window.updateVideoTimeSummary`

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

---

## Projects & formats

| Format | Use |
|--------|-----|
| `.lsv` / `.lsvz` | Primary project / packaged project |
| `.tmv` / `.tmvz` | Legacy — still open |

localStorage: `lfvideo_project` (current). `timeStudyData` = legacy migrate-once key only.

Rust command names may still say `load_tspz_bundle` / `save_tspz_bundle` — internal; rename later if desired.

---

## Markers

- Types include normal + **loop** (badge, cyan region, repeat N times).
- Table actions require window-bound handlers + event delegation after re-render.
- Easter egg: rename marker to `terry` or `tetris` → Tetris in settings panel.
- **Speed** marker type: planned, not done.

---

## Timeline / filmstrip

- Custom canvas waveform + filmstrip (Peaks.js / Whisper **removed** — do not re-add).
- Stale-job guard: `window._timelineGenId` + request path check on async completion.
- Per-video thumbnail cache dir in Rust.
- **Skip** filmstrip/thumb generation for audio-only files.

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

---

## Related docs

- `ARCHITECTURE_NUANCES.md` — footguns and “why it is this way”
- `README.md` — user-facing overview
