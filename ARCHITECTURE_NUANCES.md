# LS.Video — ARCHITECTURE_NUANCES

Footguns and “why it is this way.” Pair with `AGENT_MAP.md`.

---

## 1. Identity & branding

- productName `LS.Video`, identifier `com.leanstudio.lsvideo`
- Version lives in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `ui/state.js` (`APP_VERSION`), and window/title strings — bump together on release

---

## 2. Path normalization (UNC)

Preserve `\\server\share\...`. Only strip `\\?\` extended prefixes. Do not turn UNC into single-slash paths.

---

## 3. Single load pipeline

**Law:** one entry (`window.loadVideo`). Proxy decision only in Rust `verify_and_prepare_video`. Path → `src` only via `pathToAssetUrl`.

---

## 4. Proxy vs audio vs web-safe video

`is_web_safe_video` looks for Video: lines (h264/avc/vp8/vp9/av1). **mp3 has no video line** → naive logic would proxy audio into a nonsense MP4.

Audio extensions must **short-circuit** before the “not web-safe” branch.

mpeg4/mp4v in MP4 is also not web-safe for WebView2 → proxy (seen on mislabeled “H265-Test” files that were actually mpeg4).

**HEVC / H.265 (`hev1` / `hvc1` / probe `hevc`):** default is **always proxy** to H.264 MP4. Reasons:

1. WebView2 does not reliably decode HEVC without the separate Windows HEVC extension and still varies by machine.
2. macOS WKWebView *can* play many HEVC files in Safari, but Tauri’s WebView is not a guarantee of the same codec path; seeking, multi-track, and odd containers still fail.
3. One code path keeps filmstrip/export/proxy cache coherent (export already goes through ffmpeg).

**Experiment (do not merge without data):** on macOS only, optionally attempt `pathToAssetUrl(original)` first for pure HEVC-in-MP4; on `MediaError` or `error` event, fall back to `verify_and_prepare_video` proxy and keep using that path for the session. Never skip proxy for AVI/MKV/unsafe containers. Capture: cold-open time, first-frame time, seek accuracy, whether filmstrip still needs ffmpeg decode.

On queue delete/replace: purge hash-keyed proxy under app cache (`delete_proxy_for_video`) and clear CC tracks so captions/proxy paths do not stick to the next source.

---

## 5. ES modules vs window

`app.js` = module scope. Inline handlers and non-module scripts cannot see module locals.

Markers table “visible but dead” = handlers not on `window`. Timeline `player is not defined` = `window.player` not set in `initializePlayer`.

---

## 6. View mode vs localStorage

- **Rehydrate video from localStorage only in Normal.**
- Miniplayer/cinema are for watching, not restoring a full editor session into a tiny/always-on-top window.
- Cinema **Esc → miniplayer**, not Normal (avoids editor restore when user only wanted to see the desktop).
- Cold start (no launch file) → **Normal**.
- Raw media launch → **Miniplayer** + that file.
- `.lsv` / `.lsvz` (legacy tmv) → **Normal** + project.

---

## 7. Filmstrip races

Generation tokens / path stamps cancel stale async thumb batches when the user switches queue items quickly.

Skip entire filmstrip pipeline for audio-only (ffmpeg “no video stream”).

---

## 8. Join sequence spine (flush boundaries)

`joinedToNext` only when both neighbours are the same media class (audio+audio or video+video). Mixed joins break ffmpeg (video filters on audio, concat map failures). Use `canJoinQueueIndices` / `normalizeInvalidJoins`; never re-enable mixed join “for convenience.”

---

## 9. Timeline zoom (detailed panel only)

Does not affect the transport seek bar. Content width scales; scroll parent is `#timeline-h-scroll`.

---

## 10. Batch export IPC (`export_queue_job`)

Export uses ffmpeg sidecar decode (works for HEVC/proxy sources). Never delete source media. Fail one job → continue batch.

**Errors:** toast `humanizeExportError` (short). Do not surface multi-kilobyte ffmpeg stderr as the only user feedback. Rust rejects mixed audio+video segment lists with a clear string.

---

## 11. Closed captions hygiene

Clear tracks on media change. Soft VTT next to batch outputs is best-effort.

---

## 12. Butterchurn / CSP

`script-src 'unsafe-eval'` required. Viz is audio-only. Missing `.map` produces console noise only.

---

## 13. Tokio / Tauri runtime

In `setup`, use `tauri::async_runtime::spawn`, not a bare `tokio::spawn` that assumes an external runtime — caused:

`there is no reactor running, must be called from the context of a Tokio 1.x runtime`

---

## 14. ffmpeg sidecar

- `externalBin: ["binaries/ffmpeg"]` → platform-triple-named binary under `src-tauri/binaries/`
- Not in git (too large). Local/CI must supply before `tauri build`
- Published under GH Release tag e.g. `ffmpeg-n9.0-lsvideo` (win / linux / mac); app CI downloads them
- Full builds that link **libx264** are **GPL** — see root `LICENSE` §2 (bundled FFmpeg). App source stays MIT; do not call the whole installer MIT-only
- **macOS must be fully static** — no Homebrew `libx264.*.dylib`. Signed app + Homebrew dylib → dyld Team ID mismatch and proxy abort
- Batch/join export and proxy share this sidecar
- Verify a new Mac binary with `otool -L` (no `/opt/homebrew` / `/usr/local` deps) before shipping

---

## 15. Fonts

Self-host Inter under `ui/fonts`. Broken `@font-face` URLs → OTS `invalid sfntVersion` spam. No CDN for a local-first app.

---

## 16. tailwind.css noise

`watch:css` rewrites `ui/tailwind.css` constantly. Treat as build artifact noise in git status unless you intentionally commit a production minify. Prefer `git restore ui/tailwind.css` before commits.

---

## 17. Signing & distribution

- Windows SmartScreen: unsigned NSIS warns; OV/EV cert is **per publisher/year**, not per app
- R2 (Cloudflare) fine for large installers; GH Releases has size limits
- macOS: Apple Developer ID Application cert (not Installer) in `APPLE_CERTIFICATE`; notarization needs app-specific password (`APPLE_PASSWORD`), not the Apple ID login password
- macOS also needs fully static arm64 ffmpeg (see §14) or proxy fails inside the signed `.app`
- **Updater:** each release uploads Tauri `latest.json` + `.sig` when `TAURI_SIGNING_*` secrets and `createUpdaterArtifacts` are set. Public feed: `https://lean.studio/lsvideo/latest.json`. Do not re-tag published versions to “add” updater bits — ship the next semver
- UX: `ui/js/updater.js` (Cancel | Now | When I close). Suite-wide contract lives in `SUITE_MAP.md` on `lean-studio-web`

---

## 18. Legacy names still present (intentional)

| Name | Why |
|------|-----|
| `timeStudyData` | localStorage migration only |
| `load_tspz_bundle` / `save_tspz_bundle` | Rust command IDs; rename is a coordinated breaking change |
| `processStartTime` / `processEndTime` | Migration normalize → clipIn/clipOut |

Do not reintroduce time-study **features**. Migrating away residual names is fine when touched.

---

## 19. Speed markers, export order, timeline warp

**Marker model:** `type: "speed"`, `speedValue` clamped 0.25–4. Rate applies from that marker’s time until the next speed marker (or clip out). Gaps default to 1×. Shared builder: `buildSpeedRanges(markers, clipIn, clipOut)` → `[{ start, end, rate }, …]` covering the clip.

**Live playback:** `applyActiveSpeedPlayback` sets `video.playbackRate` from the active range. Footer speed slider snaps to the active marker’s range and writes back `speedValue` while dragging. Exactly **1×** does not paint orange speed-zone tint (visual noise).

**Export pipeline (do not reorder casually):** per segment

1. Trim to `[clipIn, clipOut]` (source time)
2. Split into speed ranges; each piece: `setpts=(PTS-STARTPTS)/rate` + chained `atempo` (0.5–2 per stage); **`-t span/rate`** so output length is correct (missing this → slow-mo files still “full source duration”)
3. Concat speed pieces
4. Edge `fade` / `afade` on **output** time (`fade_in_sec` / `fade_out_sec`, default 0)
5. Quality / strip-audio as configured

Join runs: per-segment process then concat segments. Fades stay per-segment.

**Time mapping:** `sourceTimeToEffective` / `effectiveTimeToSource` are the single source of truth for ∫ dt/rate. Solo detailed timeline (ruler, playhead, scrub, filmstrip/waveform layout) uses **output** time over **full media duration** (0..mediaDuration), not the clipIn..clipOut window — so users can drag Clip Out into former “grey” media. Clip bounds still drive stop/handoff/export. Seek bar scrub must inverse-map effective → source before assigning `video.currentTime`. After speed/marker/clip edits call `scheduleSpeedTimelineRebuild`.

**IPC:** `VideoSegment.speed_ranges` as `{ start, end, rate }[]`. Still never send both `loop_count` and `loopCount`.

**Fade UX footgun:** default stored fade is **0** (`FADE_DEFAULT_SEC`). Type-menu input may show a 1.0 placeholder for convenience; clearing sets 0. Live + export fade-out reaches solid black slightly **before** clipOut (`fadeOutEarlyBlackSec` / Rust early black ~2 frames) so park-at-out is not mid-grey.

**Marker drag footgun:** overlay handles at `left: 100%` clip off the scrollport — nudge end handles inward and center with `translateX(-50%)`. Drop must call `updateMarkersListImmediate` (debounced list rebuild can skip the final time).

---

## 20. Audio vs video queue pickers

| Queue kind | Dialog filters |
|------------|----------------|
| Empty | Both audio + video |
| All audio | Audio extensions only |
| Any video | Video extensions only |

Symptom if wrong: after loading MP3, “+” still filters video containers only → awkward second-track add. Fix: `getOpenMediaDialogFilters()` from `getQueueMediaKind()`.

Do not invent mixed audio+video playlists via the open dialog once a video is present (product policy). Join already forbids mixed classes.

---

## 21. Known product backlog (not blockers)

- Butterchurn preset UX polish / optional viz on video (explicitly rejected for now)
- CSP `style-src` console noise on some Mac builds (UI OK; still noisy)
- Settings UI: “Check for updates on launch” + Help “Check now” (`checkForUpdatesNow` is ready)
- Installer/R2 public pipeline (optional; GH Releases + lean.studio feed works)
- Rename Rust tspz commands + drop legacy localStorage key after a grace release
- Batch: optional richer VTT timing under speed warp (soft VTT sidecars exist; sequence shift is clip-duration based today)
- Multi-clip join detailed timeline fully speed-warped end-to-end (solo path is warped; join sequence offsets still use raw clip spans)
- **HEVC experiment:** macOS try-native-then-proxy (see §4) — measurement only until parity is proven

---

## 22. Path → WebView asset URL

**Symptom:** macOS WKWebView 404 / media fail when the UI hand-builds `https://asset.localhost/${encodeURIComponent(path)}`. Windows WebView2 wants `https://asset.localhost/…`; macOS wants `asset://…` with the **entire** path percent-encoded (`/` → `%2F`). Native `convertFileSrc` already does this.

**Law:** `pathToAssetUrl` in `ui/js/path-to-asset-url.js` (imported by `app.js`) is the only converter.

1. Prefer `window.__TAURI__.core.convertFileSrc` (then `.tauri.convertFileSrc`).
2. Rare fallback (matches `@tauri-apps/api`): Windows → `https://asset.localhost/${encodeURIComponent(path)}`; else → `asset://${encodeURIComponent(path)}`.
3. No Tauri / non-string / empty → return the input unchanged.

Call it for every filesystem-backed `src`: `video.src`, caption `track.src`, filmstrip `img.src`. Do **not** call `convertFileSrc` or `encodeURIComponent` at those sites. Blob URLs, HTTP `?v=`, and empty-src clears stay as-is.

`normalizePath` still runs first (UNC). `pathToAssetUrl` does not strip or rewrite slashes — it only encodes.

Tests: `tests/pathToAssetUrl.spec.js`.

---

## Quick “don’t do this” list

1. Don’t re-add Failsafe Proxy or Peaks/Whisper  
2. Don’t strip UNC `\\`  
3. Don’t proxy mp3  
4. Don’t size viz canvas from video metrics on audio  
5. Don’t branch fixes off unmerged feature branches without rebasing onto main  
6. Don’t commit tailwind watch churn by accident  
7. Don’t map Cinema Esc → Normal  
8. Don’t send both `loop_count` and `loopCount` on the same `VideoSegment` JSON  
9. Don’t stretch sequence filmstrip fills to 100% width (destroys join geometry)  
10. Don’t apply edge fades before speed pieces (fade must be on output time)  
11. Don’t omit `-t span/rate` on speed-filtered ffmpeg pieces  
12. Don’t paint 1× speed zones with orange tint  
13. Don’t join or batch-export mixed audio+video runs  
14. Don’t shrink the solo detailed timeline to clipIn..clipOut (full media + grey bounds)  
15. Don’t apply video fade filters (`-vf fade`) to audio-only exports  
16. Don’t assign filesystem `src` via raw `convertFileSrc` / `encodeURIComponent` — use `pathToAssetUrl`  
17. Don’t use a Windows-only `https://asset.localhost/…` fallback on macOS (`asset://` + full-path encode)  
18. Don’t ship a macOS ffmpeg that links Homebrew dylibs (signed app proxy will abort)  
19. Don’t remove HEVC→proxy without a measured try-native fallback  
20. Don’t re-tag a published GitHub Release to inject updater artifacts — bump semver  
