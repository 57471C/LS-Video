# LS.Video

[![Version](https://img.shields.io/badge/version-0.6.1-brightgreen)](https://github.com/57471C/TMVideo/blob/main/LICENSE)

LS.Video is a premium, high-performance chapter bookmarking, timeline review, and video annotation tool. Built with a fast, frameworkless Vanilla JS/CSS frontend and a lightweight **Rust Tauri** backend, it bypasses standard browser sandbox memory limits to load and parse production-grade video assets instantly. 

The application utilizes local asset streams backed by a custom secure proxy pipeline, avoiding browser compilation lag while rendering frame-accurate timeline annotations.

---

## Unified Workspace View Profiles

LS.Video features a strict, class-driven modal state machine (`normal-mode`, `cinema-mode`, and `miniplayer-mode`) managed seamlessly via plain CSS selectors on the `<body>` element. This eliminates manual inline JavaScript style pollution and prevents layout side-effects.

### 1. Normal Workspace (Editing Dashboard)
The complete multi-column workspace environment built for asset management, timeline indexing, and marker mapping.
* **Layout Grid:** Active sidebars (playlist queue and detailed editing lanes) alongside an embedded data matrix table.
* **Aesthetic:** Styled using a premium, low-glare off-black canvas theme (`#121214`).

![Normal Mode Workspace](assets/normal-screenshot.png)

### 2. Cinema Mode (Focused Review)
An absolute fullscreen, distraction-free environment optimized for high-velocity timeline review.
* **Window Behavior:** Leverages native Tauri window execution loops to enter absolute device fullscreen mode.
* **Interface:** Blasts away all playlists, control sidebars, margins, and data tables. The video asset automatically blows up to fill the device boundaries.
* **Controls Deck:** Interactive player mechanics float as an absolute centered overlay that automatically fades out of sight after 5 seconds of keyboard or mouse inactivity.

![Cinema Mode Focus](assets/cinema-screenshot.png)

### 3. Miniplayer Mode (Floating Compact Widget)
A sleek, float-locked media companion designed to hover on top of your editing environment or secondary view screen.
* **Window Behavior:** Scales the physical window border frame automatically to a sleek widget footprint (`580px x 480px`), strips native maximize/minimize anchors, and locks the application to `AlwaysOnTop`.
* **Interface Mechanics:** Drops sidebars and indexes, pinning the primary playback buttons cleanly and flush against the bottom edge of the visible window.

![Miniplayer Compact Widget](assets/miniplayer-screenshot.png)

*The interface fully supports a clean fallback layer for light-themed operational setups.*
![Light Mode Workspace Layout](assets/lightmode-screenshot.png)

---

## Native OS Launch Subsystem

The application features deep Windows registry integration for automatic workspace routing depending on what file format you open directly from your operating system explorer context:

* **Raw Video Files (`.mp4`, `.avi`, `.mkv`, `.mov`, `.mpg`):** Double-clicking directly launches the app as a compact, floating **Miniplayer Widget** on top of your workspace, immediately processing the video stream.
* **Project Files & Data Tables (`.lsv`, `.lsvz`, legacy `.tmv`, `.tmvz`):** Double-clicking instantly expands into a maximized **Normal Workspace**, automatically rehydrating all historical timeline markers, timestamps, metadata, and visual track layouts.
* **Cold Boots:** Launching the app directly without parameters forces a clean maximized state into a fresh, empty workspace session.

---

## Technical Architecture & Timeline Tracks

LS.Video values speed and minimalism, entirely avoiding heavy third-party framework layers (such as Peaks.js or Wavesurfer.js) or cloud transcription weights.

* **High-Performance Canvas Timeline:** Audio tracks and video filmstrips are rendered using low-level, pure HTML5 2D canvas drawings, enabling lag-free frame lookups.
* **Isolated DOM Component Purging:** The application relies on a strict lifecycle separation. Standalone `.lsv` / `.tmv` data imports only swap marker data points, preserving your running visual timeline. True project switches or "New Project" resets perform clean canvas context wipes (`ctx.clearRect`) and empty image buffers without destroying core structural DOM layouts.
* **Code Health & Compilation:** Code validation is enforced via the high-speed **Biome compiler toolchain** to maintain syntax uniformity across all tracking engines.

---

## Installation & Active Development

### Prerequisites
* [Node.js](https://nodejs.org/) (v18+ recommended)
* [Rust Toolchain](https://www.rust-lang.org/) (via `rustup`)

### Setup Loop
1. Clone the master directory:
   ```bash
   git clone [https://github.com/57471C/TMVideo.git](https://github.com/57471C/TMVideo.git)
   cd TMVideo
   ```

2. Ingest required node packages:
   ```bash
   npm install
   ```

3. Boot up the local hot-reloading development system:
   ```bash
   npx tauri dev
   ```

4. Run code formatting and syntax compliance analyses:
   ```bash
   npx biome check . --write
   ```


---
License: Distributed under the MIT Open-Source parameters. Created and maintained by 57471C.