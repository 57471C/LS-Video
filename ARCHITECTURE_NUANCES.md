# LS.Video — ARCHITECTURE_NUANCES

Hard-won constraints. Agents: prefer reading this over rediscovering via breakage.

Last oriented: v0.6.1 (Butterchurn + UNC path fix era).

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

## 8. Butterchurn / CSP

Milkdrop presets compile via `new Function()` → CSP must include **`unsafe-eval`** or init throws `EvalError` forever.

`createMediaElementSource(video)` **once** per element lifetime. Graph must reach `destination` or audio is silent.

Canvas size from **wrapper clientWidth/Height × DPR**, not `video.videoWidth` (0 for audio). Hide/opacity-0 the `<video>` for audio-only so it doesn’t impose a wrong aspect box.

Do not offer viz toggle on video media (users assume exportable “effect”).

---

## 9. Tokio / Tauri runtime

In `setup`, use `tauri::async_runtime::spawn`, not a bare `tokio::spawn` that assumes an external runtime — caused:

`there is no reactor running, must be called from the context of a Tokio 1.x runtime`

---

## 10. ffmpeg sidecar

- `externalBin: ["binaries/ffmpeg"]` → platform-triple-named binary under `src-tauri/binaries/`
- Not in git (too large). Local/CI must supply before `tauri build`
- Full builds that link **libx264** are **GPL** — see root `LICENSE` §2 (bundled FFmpeg). App source stays MIT; do not call the whole installer MIT-only
- Custom minimal ffmpeg is optional size work, not required for correctness

---

## 11. Fonts

Self-host Inter under `ui/fonts`. Broken `@font-face` URLs → OTS `invalid sfntVersion` spam. No CDN for a local-first app.

---

## 12. tailwind.css noise

`watch:css` rewrites `ui/tailwind.css` constantly. Treat as build artifact noise in git status unless you intentionally commit a production minify. Prefer `git restore ui/tailwind.css` before commits.

---

## 13. Signing & distribution

- Windows SmartScreen: unsigned NSIS warns; OV/EV cert is **per publisher/year**, not per app
- R2 (Cloudflare) fine for large installers; GH Releases has size limits
- macOS: separate Apple signing/notarization; Tauri ports but needs arm64 ffmpeg + Mac build

---

## 14. Legacy names still present (intentional)

| Name | Why |
|------|-----|
| `timeStudyData` | localStorage migration only |
| `load_tspz_bundle` / `save_tspz_bundle` | Rust command IDs; rename is a coordinated breaking change |
| `processStartTime` / `processEndTime` | Migration normalize → clipIn/clipOut |

Do not reintroduce time-study **features**. Migrating away residual names is fine when touched.

---

## 15. Known product backlog (not blockers)

- Marker type: **Speed** (playbackRate segments)
- Butterchurn preset UX polish / optional viz on video (explicitly rejected for now)
- Installer/R2 public pipeline
- Mac target
- Rename Rust tspz commands + drop legacy localStorage key after a grace release

---

## Quick “don’t do this” list

1. Don’t re-add Failsafe Proxy or Peaks/Whisper  
2. Don’t strip UNC `\\`  
3. Don’t proxy mp3  
4. Don’t size viz canvas from video metrics on audio  
5. Don’t branch fixes off unmerged feature branches without rebasing onto main  
6. Don’t commit tailwind watch churn by accident  
7. Don’t map Cinema Esc → Normal  
