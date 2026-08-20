# LS.Video — ARCHITECTURE_NUANCES

Hard-won constraints. Agents: prefer reading this over rediscovering via breakage.

Last oriented: v0.6.2 + audio/video queue guards, detailed timeline marker drag, full-media solo timeline, modal polish, Speed markers + fades + batch export.

---

## 1. Identity & branding

| Item | Value |
|------|--------|
| Display name | LS.Video |
| Identifier | `com.leanstudio.lsvideo` |
| npm / Cargo name | `ls-video` |

Changing `identifier` = new Windows app (separate AppData, install path). Old TMVideo installs do not share state.

---

## 2. Path normalization (UNC)

**Symptom:** `\\server\share\file.mp4` becomes `server\share\file.mp4` → `asset.localhost` 404.

**Rule:** only strip Windows **extended** prefixes:

```text
\\?\C:\foo              → C:\foo
\\?\UNC\server\share\x  → \\server\share\x
\\server\share\x        → unchanged
C:\foo                  → unchanged
```

Never use a regex that strips a leading `\\` from normal UNC. Same normalize for drag-drop, dialogs, and OS launch args.

Network/Outlook “open” failures at work were this class of bug, not “email magic.”

---

## 3. Single load pipeline

Duplicate `loadVideo` / direct `convertFileSrc` / Failsafe Proxy caused:

- Double optimizing overlay
- Empty-src toast spam
- H.265 path inconsistencies

**Law:** one entry (`window.loadVideo`). Proxy decision only in Rust `verify_and_prepare_video`.

Empty `http://127.0.0.1:1430/` (or origin-only) MediaError during load = transitional; suppress with `_videoLoadInProgress`, do not toast as hard failure.

---

## 4. Proxy vs audio vs web-safe video

`is_web_safe_video` looks for Video: lines (h264/avc/vp8/vp9/av1). **mp3 has no video line** → naive logic would proxy audio into a nonsense MP4.

Audio extensions must **short-circuit** before the “not web-safe” branch.

mpeg4/mp4v in MP4 is also not web-safe for WebView2 → proxy (seen on mislabeled “H265-Test” files that were actually mpeg4).

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

Async thumb jobs complete out of order when switching videos fast.

Use generation token + path guard; ignore stale `.then` results. Per-video cache subdirectory in Rust so thumbs don’t overwrite each other.

Skip entire filmstrip pipeline for audio-only (ffmpeg “no video stream”).

---

## 8. Join sequence spine (flush boundaries)

Playback and export both assume:

```text
sequenceOffset(0) = 0
segmentDuration(i) = max(0, clipOut_i − clipIn_i)   // speed-warped when ranges exist
sequenceOffset(i+1) = sequenceOffset(i) + segmentDuration(i)
```

So clip N’s sequence out **equals** clip N+1’s sequence in (one vertical cut on multi-row timeline).

`clipIn`/`clipOut` must stay in sync with in/out markers (`syncClipBoundsFromMarkers`). Multi-clip footer used to skip that sync → wrong segment widths until fixed.

Joined rows show **full source** filmstrip/waveform mapped so the active `[clipIn, clipOut]` band aligns with the sequence slot; head/tail are tinted (solo-like) so users see the file is longer than the joined segment.

Transport bar: multi-clip = **sequence** clock; do not apply solo “black after local clipOut” to the whole bar.

**Join class law:** `joinedToNext` only when both neighbours are the same media class (audio+audio or video+video). Mixed joins break ffmpeg (video filters on audio, concat map failures). Use `canJoinQueueIndices` / `normalizeInvalidJoins`; never re-enable mixed join “for convenience.”

---

## 9. Timeline zoom (detailed panel only)

- `zoom = 1`: content width = scrollport clientWidth (fit); no H-scroll.
- `zoom > 1`: content width = fit × factor; overflow-x on `#timeline-h-scroll` wrapping **ruler + tracks + marker overlay** so one `scrollLeft` keeps alignment.
- Click-to-seek must use the **content** box (wide element rect), not the viewport-only width.
- Debounce filmstrip/waveform regen on slider; live CSS width updates are fine every tick.
- User zoom factor survives resize; force fit when `userOverride` is false (including Fit button / double-click slider).

---

## 10. Batch export IPC (`export_queue_job`)

Jobs come from `buildBatchJobsFromQueue()` (walk same-class `joinedToNext` only).

**Serde trap:** Rust `VideoSegment` has `loop_count` with `alias = "loopCount"`. Sending **both** keys in one JSON object →  
`invalid args … duplicate field loop_count`.

**Law:** flat segment objects, **one** key per field. Prefer `loop_count` only (or only `loopCount`, not both). Same for join_and_compress payloads. Optional `audio_only` / `audioOnly` for audio-safe encode.

Export uses ffmpeg sidecar decode (works for HEVC/proxy sources). Never delete source media. Fail one job → continue batch.

**Audio-only jobs:** no video stream — do not apply `-vf` / libx264. Rust path uses `-vn`, `afade` only, AAC, `.m4a` temps/output; multi-audio concat is `concat=n:v=0:a=1`. Video jobs stay on the existing trim → speed → fade → quality pipeline.

**Errors:** toast `humanizeExportError` (short). Do not surface multi-kilobyte ffmpeg stderr as the only user feedback. Rust rejects mixed audio+video segment lists with a clear string.

Batch export toggle is **checked by default** in the trim/export settings panel.

---

## 11. Closed captions hygiene

- `clearSubtitleTracks` removes `<track>` / cues **without** necessarily clearing `video.src`.
- Media replace / queue switch / delete must clear CC so captions from A do not show on B.
- Button visuals: none / available-off / active-on via `setCcButtonState` (not ad-hoc yellow classes).

---

## 12. Butterchurn / CSP

Milkdrop presets compile via `new Function()` → CSP must include **`unsafe-eval`** or init throws `EvalError` forever.

`createMediaElementSource(video)` **once** per element lifetime. Graph must reach `destination` or audio is silent.

Canvas size from **wrapper clientWidth/Height × DPR**, not `video.videoWidth` (0 for audio). Hide/opacity-0 the `<video>` for audio-only so it doesn’t impose a wrong aspect box.

Do not offer viz toggle on video media (users assume exportable “effect”).

---

## 13. Tokio / Tauri runtime

In `setup`, use `tauri::async_runtime::spawn`, not a bare `tokio::spawn` that assumes an external runtime — caused:

`there is no reactor running, must be called from the context of a Tokio 1.x runtime`

---

## 14. ffmpeg sidecar

- `externalBin: ["binaries/ffmpeg"]` → platform-triple-named binary under `src-tauri/binaries/`
- Not in git (too large). Local/CI must supply before `tauri build`
- Full builds that link **libx264** are **GPL** — see root `LICENSE` §2 (bundled FFmpeg). App source stays MIT; do not call the whole installer MIT-only
- Custom minimal ffmpeg is optional size work, not required for correctness
- Batch/join export and proxy share this sidecar

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
- macOS: separate Apple signing/notarization; Tauri ports but needs arm64 ffmpeg + Mac build

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

**Marker model:** `type: "speed"`, `speedValue` clamped 0.25–8. Rate applies from that marker’s time until the next speed marker (or clip out). Gaps default to 1×. Shared builder: `buildSpeedRanges(markers, clipIn, clipOut)` → `[{ start, end, rate }, …]` covering the clip. Transport slider and keys 1–8 share that clamp (backtick = 0.5×, 1–8 = 1×–8×).

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
- Installer/R2 public pipeline
- Mac target
- Rename Rust tspz commands + drop legacy localStorage key after a grace release
- Batch: optional richer VTT timing under speed warp (soft VTT sidecars exist; sequence shift is clip-duration based today)
- Multi-clip join detailed timeline fully speed-warped end-to-end (solo path is warped; join sequence offsets still use raw clip spans)

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
