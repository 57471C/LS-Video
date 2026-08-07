/*
 * Timeline Engine Module for LS.Video
 * Manages playhead tracking, ticks rendering, audio canvas painting, and marker/trim shading.
 * Supports solo clip mode and multi-segment active join-run sequence mode.
 * Horizontal zoom: factor 1 = fit width; factor > 1 widens content + H-scroll.
 */

window.playheadAnimationId = null;
window.lastCheckedVideoTime = 0;

let cachedVideoElement = null;

/** @type {{ factor: number, userOverride: boolean, fitWidth: number, contentWidth: number, pxPerSecond: number }} */
window._timelineZoom = window._timelineZoom || {
	factor: 1,
	userOverride: false,
	fitWidth: 0,
	contentWidth: 0,
	pxPerSecond: 0,
};

const TIMELINE_ZOOM_MIN = 1;
const TIMELINE_ZOOM_MAX = 8;

/** Resolve the video element — module-scoped `player` in app.js is not visible here. */
const getPlayer = () =>
	window.player ||
	document.querySelector("video") ||
	document.getElementById("my_video");

const isPlayerReady = () =>
	window.playerReady === true ||
	(typeof playerReady !== "undefined" && playerReady);

/** Sequence mode when active join run has 2+ clips (live query, not only cached flag). */
const isSequenceMode = () => {
	if (window._sequenceMode?.active) return true;
	if (typeof window.isActiveRunMulti === "function") {
		return window.isActiveRunMulti();
	}
	if (typeof window.getActiveJoinRun === "function") {
		const run = window.getActiveJoinRun();
		return !!(run?.segments && run.segments.length > 1);
	}
	return false;
};

const getTimelineDuration = () => {
	if (isSequenceMode()) {
		if (typeof window.getActiveJoinRun === "function") {
			const run = window.getActiveJoinRun();
			if (run?.totalDuration > 0) return run.totalDuration;
		}
		return Math.max(window._sequenceMode?.totalDuration || 0, 0.001);
	}
	const p = getPlayer();
	return Math.max(p?.duration || 0, 0.001);
};

const getTimelineScrollport = () =>
	document.getElementById("timeline-h-scroll");

const getTimelineZoomContent = () =>
	document.getElementById("timeline-zoom-content");

/** Visible scrollport width used for fit-to-width (zoom = 1). */
const getTimelineFitWidth = () => {
	const port = getTimelineScrollport();
	if (port?.clientWidth > 0) return port.clientWidth;
	const panel = document.getElementById("detailed-timeline-panel");
	if (panel?.clientWidth > 0) return Math.max(panel.clientWidth - 32, 200);
	return 600;
};

/**
 * Apply content width from duration + zoom + scrollport.
 * @param {{ forceFit?: boolean }} [opts]
 */
const applyTimelineZoomLayout = (opts = {}) => {
	const z = window._timelineZoom;
	if (opts.forceFit) {
		z.factor = TIMELINE_ZOOM_MIN;
		z.userOverride = false;
	}
	const factor = Math.min(
		TIMELINE_ZOOM_MAX,
		Math.max(TIMELINE_ZOOM_MIN, Number(z.factor) || 1),
	);
	z.factor = factor;

	const fitW = getTimelineFitWidth();
	const contentW = Math.max(fitW * factor, fitW);
	const duration = getTimelineDuration();
	z.fitWidth = fitW;
	z.contentWidth = contentW;
	z.pxPerSecond = contentW / Math.max(duration, 0.001);

	const content = getTimelineZoomContent();
	if (content) {
		content.style.width = `${contentW}px`;
		content.style.minWidth = `${contentW}px`;
		content.style.maxWidth = "none";
	}

	const port = getTimelineScrollport();
	if (port) {
		// H-scroll only when zoomed past fit
		port.style.overflowX = factor > 1.001 ? "auto" : "hidden";
	}

	// Keep controls in sync
	const slider = document.getElementById("timelineZoomSlider");
	if (slider && Number(slider.value) !== factor) {
		slider.value = String(factor);
	}
	const label = document.getElementById("timelineZoomLabel");
	if (label) {
		label.textContent =
			factor <= 1.001 ? "Fit" : `${factor.toFixed(factor >= 2 ? 1 : 2)}×`;
	}

	return z;
};

/**
 * Set zoom factor from UI.
 * @param {number} factor
 * @param {{ fromUser?: boolean, regenerate?: boolean }} [opts]
 */
const setTimelineZoom = (factor, opts = {}) => {
	const z = window._timelineZoom;
	const next = Math.min(
		TIMELINE_ZOOM_MAX,
		Math.max(TIMELINE_ZOOM_MIN, Number(factor) || 1),
	);
	z.factor = next;
	if (opts.fromUser !== false) {
		z.userOverride = next > 1.001;
	}
	if (next <= 1.001) z.userOverride = false;
	applyTimelineZoomLayout();

	if (opts.regenerate !== false) {
		// Debounce expensive filmstrip/waveform rebuilds
		if (window._timelineZoomRegenTimer) {
			clearTimeout(window._timelineZoomRegenTimer);
		}
		window._timelineZoomRegenTimer = setTimeout(() => {
			window._timelineZoomRegenTimer = null;
			if (typeof window.loadWaveformTimeline === "function") {
				window.loadWaveformTimeline();
			} else {
				const dur = getTimelineDuration();
				paintTimelineRuler(dur);
				if (typeof window.paintTimelineMarkersAndShading === "function") {
					window.paintTimelineMarkersAndShading();
				}
			}
		}, 180);
	}
	return z;
};

const resetTimelineZoomToFit = () => {
	setTimelineZoom(TIMELINE_ZOOM_MIN, { fromUser: false, regenerate: true });
};

/**
 * Map a click on a timeline element to time, accounting for scroll + zoomed width.
 * Uses the full content box (getBoundingClientRect of wide child already includes scroll).
 */
const timeFromTimelineClick = (clientX, trackEl) => {
	const content = getTimelineZoomContent() || trackEl;
	const el = content || trackEl;
	if (!el) return 0;
	const rect = el.getBoundingClientRect();
	const width = rect.width || window._timelineZoom?.contentWidth || 1;
	const x = clientX - rect.left;
	const pct = Math.max(0, Math.min(1, x / Math.max(width, 1)));
	return pct * getTimelineDuration();
};

/** Content width for filmstrip density / layout consumers. */
const getTimelineContentWidth = () => {
	const z = window._timelineZoom;
	if (z?.contentWidth > 0) return z.contentWidth;
	const content = getTimelineZoomContent();
	if (content?.offsetWidth > 0) return content.offsetWidth;
	return getTimelineFitWidth();
};

window.applyTimelineZoomLayout = applyTimelineZoomLayout;
window.setTimelineZoom = setTimelineZoom;
window.resetTimelineZoomToFit = resetTimelineZoomToFit;
window.getTimelineContentWidth = getTimelineContentWidth;
window.getTimelineFitWidth = getTimelineFitWidth;

const getPlayheadTime = () => {
	if (
		isSequenceMode() &&
		typeof window.getSequencePlayheadTime === "function"
	) {
		return window.getSequencePlayheadTime();
	}
	const p = getPlayer();
	return p?.currentTime || 0;
};

const seekTimelineTime = (time) => {
	// Prefer sequence seek whenever active run is multi-clip.
	// Omit `play` so prior play/pause state is preserved (scrub while playing continues).
	if (isSequenceMode() && typeof window.seekSequenceTime === "function") {
		void window.seekSequenceTime(time, { silent: true });
		return;
	}
	const p = getPlayer();
	if (p) p.currentTime = time;
};

// Cache the live HTMLCollection of playheads globally so we don't query the DOM repeatedly in the animation frame
const timelinePlayheadsLive =
	document.getElementsByClassName("sequencer-playhead");

function syncTimelinePlayheadSmoothly() {
	const player = getPlayer();
	// Keep animating through handoff loads when possible
	if (
		player &&
		isPlayerReady() &&
		(player.duration || isSequenceMode()) &&
		!window._sequenceHandoffInProgress
	) {
		const currentVideoTime = player.currentTime;
		const duration = getTimelineDuration();

		// Look-ahead intersection delta calculation for jump markers (source-local)
		if (currentVideoTime > window.lastCheckedVideoTime) {
			if (markers && markers.length > 0) {
				const activeVideo =
					(typeof videoQueue !== "undefined" && videoQueue[activeQueueIndex]) ||
					{};
				const endLimit =
					activeVideo.virtualEndTime !== null &&
					activeVideo.virtualEndTime !== undefined
						? activeVideo.virtualEndTime
						: player.duration;

				for (let i = 0; i < markers.length; i += 1) {
					const marker = markers[i];
					if (marker.type === "jump") {
						const nextMarker = markers[i + 1];
						const boundaryTime = nextMarker ? nextMarker.startTime : endLimit;

						// Did the video playhead pass over this marker time during this frame tick?
						if (
							marker.startTime >= window.lastCheckedVideoTime &&
							marker.startTime <= currentVideoTime
						) {
							window.lastCheckedVideoTime = boundaryTime;
							player.currentTime = boundaryTime;
							break;
						}
					}
				}
			}
		}

		// Sequence time when multi-run so playhead crosses join into next segment
		if (
			isSequenceMode() &&
			typeof window.syncSequenceModeState === "function"
		) {
			window.syncSequenceModeState();
		}
		const playheadTime = getPlayheadTime();
		const completionPercent = (playheadTime / Math.max(duration, 0.001)) * 100;
		for (let i = 0; i < timelinePlayheadsLive.length; i++) {
			timelinePlayheadsLive[i].style.left = `${completionPercent}%`;
		}
		window.lastCheckedVideoTime = player.currentTime;
	}
	window.playheadAnimationId = requestAnimationFrame(
		syncTimelinePlayheadSmoothly,
	);
}

const paintTimelineRuler = (duration) => {
	if (!duration) return;
	// Apply zoom layout so ruler width matches content (fit * factor)
	applyTimelineZoomLayout();

	const rulerTrack = document.getElementById("timeline-ruler-track");
	if (!rulerTrack) return;
	rulerTrack.innerHTML = "";
	rulerTrack.style.position = "relative";
	rulerTrack.style.overflow = "hidden";
	rulerTrack.style.width = "100%";
	rulerTrack.style.boxSizing = "border-box";

	// Create playhead
	const playhead = document.createElement("div");
	playhead.className =
		"sequencer-playhead absolute top-0 bottom-0 w-0.5 bg-blue-600 dark:bg-blue-500 pointer-events-none z-30";
	const headTime = getPlayheadTime();
	playhead.style.left = `${(headTime / duration) * 100}%`;
	rulerTrack.appendChild(playhead);

	// Add click to seek (sequence-aware; uses zoomed content coordinates)
	if (!rulerTrack.dataset.hasClickListener) {
		rulerTrack.addEventListener("click", (e) => {
			if (e.target.classList.contains("sequencer-playhead")) return;
			const dur = getTimelineDuration();
			if (!dur) return;
			const time = timeFromTimelineClick(e.clientX, rulerTrack);
			const pct = time / Math.max(dur, 0.001);
			seekTimelineTime(time);
			const calculatedPercent = pct * 100;
			for (let i = 0; i < timelinePlayheadsLive.length; i++) {
				timelinePlayheadsLive[i].style.left = `${calculatedPercent}%`;
			}
		});
		rulerTrack.dataset.hasClickListener = "true";
	}

	// More ticks when zoomed so labels stay useful
	const zFactor = Math.max(1, window._timelineZoom?.factor || 1);
	let tickInterval = 5; // seconds
	if (duration <= 15) tickInterval = 1;
	else if (duration <= 60) tickInterval = 5;
	else if (duration <= 300) tickInterval = 15;
	else if (duration <= 1200) tickInterval = 60;
	else tickInterval = 300;
	if (zFactor >= 2 && tickInterval > 1) {
		tickInterval = Math.max(1, tickInterval / 2);
	}
	if (zFactor >= 4 && tickInterval > 1) {
		tickInterval = Math.max(1, Math.floor(tickInterval / 2));
	}

	const numTicks = Math.floor(duration / tickInterval);
	for (let i = 0; i <= numTicks; i += 1) {
		const time = i * tickInterval;
		const pct = (time / duration) * 100;
		if (pct > 100) break;

		const tick = document.createElement("div");
		tick.className =
			"absolute top-0 bottom-0 border-l border-zinc-300 dark:border-zinc-600 pl-1 text-[10px] text-zinc-500 dark:text-zinc-400 z-10 select-none flex items-center";
		tick.style.left = `${pct}%`;

		// Format label as MM:SS
		const mins = Math.floor(time / 60);
		const secs = Math.floor(time % 60);
		tick.textContent = `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;

		rulerTrack.appendChild(tick);
	}
};

const attachTrackSeekListener = (trackEl) => {
	if (!trackEl || trackEl.dataset.hasClickListener) return;
	trackEl.addEventListener("click", (e) => {
		const dur = getTimelineDuration();
		if (!dur) return;
		const time = timeFromTimelineClick(e.clientX, trackEl);
		const pct = time / Math.max(dur, 0.001);
		seekTimelineTime(time);
		const calculatedPercent = pct * 100;
		for (let i = 0; i < timelinePlayheadsLive.length; i++) {
			timelinePlayheadsLive[i].style.left = `${calculatedPercent}%`;
		}
	});
	trackEl.dataset.hasClickListener = "true";
};

const appendPlayheadToTrack = (trackEl, duration) => {
	if (!trackEl) return;
	const oldPlayheads = trackEl.getElementsByClassName("sequencer-playhead");
	while (oldPlayheads.length > 0) {
		oldPlayheads[0].remove();
	}
	const playhead = document.createElement("div");
	playhead.className =
		"sequencer-playhead absolute top-0 bottom-0 w-0.5 bg-blue-600 dark:bg-blue-500 pointer-events-none z-30";
	const headTime = getPlayheadTime();
	playhead.style.left = `${(headTime / Math.max(duration, 0.001)) * 100}%`;
	trackEl.appendChild(playhead);
};

const setupVideoTrack = () => {
	const player = getPlayer();
	const videoTrack = document.getElementById("timeline-video-track");
	if (!videoTrack || !player) return;

	// Multi-join spine: never re-flex outer track into a full-width filmstrip —
	// that destroys absolute segment fills on row 1 (#timeline-video-track).
	const hasSegmentFill = !!videoTrack.querySelector(".sequence-segment-fill");
	if (hasSegmentFill || videoTrack.dataset.sequenceSpine === "1") {
		const oldPlayheads =
			videoTrack.getElementsByClassName("sequencer-playhead");
		while (oldPlayheads.length > 0) {
			oldPlayheads[0].remove();
		}
		videoTrack.style.position = "relative";
		videoTrack.style.width = "100%";
		videoTrack.style.display = "block";
		videoTrack.style.overflow = "hidden";
		const duration = getTimelineDuration();
		appendPlayheadToTrack(videoTrack, duration);
		attachTrackSeekListener(videoTrack);
		return;
	}

	// Clear any old playheads
	const oldPlayheads = videoTrack.getElementsByClassName("sequencer-playhead");
	while (oldPlayheads.length > 0) {
		oldPlayheads[0].remove();
	}
	// Solo: keep filmstrip track full-width flex so thumbs stay edge-to-edge
	videoTrack.style.position = "relative";
	videoTrack.style.width = "100%";
	videoTrack.style.boxSizing = "border-box";
	videoTrack.style.display = "flex";
	videoTrack.style.overflow = "hidden";
	videoTrack.style.justifyContent = "flex-start";
	videoTrack.style.alignItems = "stretch";

	// Re-apply equal flex on existing filmstrip tiles (no fixed pixel widths)
	const filmstripImgs = videoTrack.querySelectorAll(":scope > img");
	const n = filmstripImgs.length;
	if (n > 0) {
		const tileWidthPct = 100 / n;
		for (const img of filmstripImgs) {
			img.style.flex = "1 1 0";
			img.style.minWidth = "0";
			img.style.width = `${tileWidthPct}%`;
			img.style.boxSizing = "border-box";
			img.style.height = "100%";
			img.classList.remove("w-[120px]", "flex-shrink-0");
		}
	}

	const duration = isSequenceMode()
		? getTimelineDuration()
		: player.duration || 1;
	appendPlayheadToTrack(videoTrack, duration);
	attachTrackSeekListener(videoTrack);
};

/** Sequence mode: playheads + seek on every video/audio track in the host. */
const setupSequenceTracks = (totalDuration) => {
	const duration = totalDuration || getTimelineDuration();
	applyTimelineZoomLayout();
	const host = document.getElementById("timeline-tracks-host");
	if (!host) return;

	const tracks = host.querySelectorAll(
		".sequence-video-track, .sequence-audio-track, #timeline-video-track, #timeline-audio-track",
	);
	for (const track of tracks) {
		// Outer spine stays block+relative; do not convert to flex (would reflow fills)
		track.style.position = "relative";
		track.style.display = "block";
		track.style.width = "100%";
		track.style.overflow = "hidden";
		// Re-assert each segment fill / full-source media shell geometry
		const fill = track.querySelector(".sequence-segment-fill");
		if (fill?.dataset.leftPct != null && fill?.dataset.widthPct != null) {
			fill.style.position = "absolute";
			fill.style.top = "0";
			fill.style.bottom = "0";
			fill.style.left = `${fill.dataset.leftPct}%`;
			fill.style.width = `${fill.dataset.widthPct}%`;
			// Full-source shells may extend past the active slot — do not max-clamp
			fill.style.maxWidth = fill.classList.contains("sequence-media-shell")
				? "none"
				: `${fill.dataset.widthPct}%`;
			fill.style.right = "auto";
		}
		appendPlayheadToTrack(track, duration);
		attachTrackSeekListener(track);
	}

	// Also ensure ruler playhead is current
	const rulerTrack = document.getElementById("timeline-ruler-track");
	if (rulerTrack) {
		appendPlayheadToTrack(rulerTrack, duration);
	}
};

/** Paint waveform peaks into a target element (segment fill or full audio track). */
const renderWaveformInto = (targetEl, data) => {
	if (!targetEl) return;
	// Preserve absolute playhead siblings: clear only non-playhead children when re-filling a segment
	const existingCanvas = targetEl.querySelector("canvas");
	if (existingCanvas) existingCanvas.remove();

	if (!data || data.length === 0) return;

	const canvas = document.createElement("canvas");
	canvas.style.width = "100%";
	canvas.style.height = "100%";
	canvas.style.display = "block";
	targetEl.appendChild(canvas);

	const paint = () => {
		const rect = targetEl.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;

		const dpr = window.devicePixelRatio || 1;
		canvas.width = rect.width * dpr;
		canvas.height = rect.height * dpr;

		const ctx = canvas.getContext("2d");
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const midY = rect.height / 2;
		ctx.beginPath();
		ctx.strokeStyle = document.documentElement.classList.contains("dark")
			? "#cbd5e1"
			: "#4b5563";
		ctx.lineWidth = 1.5;

		const step = rect.width / data.length;
		for (let i = 0; i < data.length; i += 1) {
			const x = i * step;
			const amp = (data[i] / 128) * (rect.height / 2.2);
			ctx.moveTo(x, midY - amp);
			ctx.lineTo(x, midY + amp);
		}
		ctx.stroke();
	};

	const observer = new ResizeObserver(() => paint());
	observer.observe(targetEl);
	requestAnimationFrame(paint);
};

const renderAudioWaveformCanvas = () => {
	const player = getPlayer();
	const audioTrack = document.getElementById("timeline-audio-track");
	if (!audioTrack || !player) return;
	audioTrack.innerHTML = "";
	audioTrack.style.position = "relative";

	const duration = isSequenceMode()
		? getTimelineDuration()
		: player.duration || 1;
	appendPlayheadToTrack(audioTrack, duration);
	attachTrackSeekListener(audioTrack);

	const data = window.currentWaveformData;
	if (!data || data.length === 0) return;

	renderWaveformInto(audioTrack, data);
};

/**
 * Collect markers for timeline shading: solo = active markers (local);
 * multi = all sources in active run, positions in sequence time.
 */
const getTimelineMarkerEntries = () => {
	const duration = getTimelineDuration();
	if (
		isSequenceMode() &&
		typeof window.getActiveJoinRun === "function" &&
		typeof window.sourceTimeToSequence === "function"
	) {
		const run = window.getActiveJoinRun();
		const entries = [];
		for (const seg of run.segments) {
			const sourceMarkers =
				seg.queueIndex === activeQueueIndex
					? markers || []
					: seg.video?.appState?.markers || [];
			for (const marker of sourceMarkers) {
				const seqT = window.sourceTimeToSequence(
					seg.queueIndex,
					marker.startTime,
					run,
				);
				entries.push({
					...marker,
					startTime: seqT,
					_localStartTime: marker.startTime,
					_queueIndex: seg.queueIndex,
				});
			}
		}
		entries.sort((a, b) => a.startTime - b.startTime);
		return { entries, duration };
	}
	return { entries: markers || [], duration };
};

const paintTimelineMarkersAndShading = () => {
	const overlay = document.getElementById("timeline-marker-overlay");
	if (!overlay) return;
	overlay.innerHTML = "";

	const player = getPlayer();
	if (!cachedVideoElement && !player) {
		cachedVideoElement = document.querySelector("video");
	}
	const videoElement = player || cachedVideoElement;
	if (!videoElement?.duration && !isSequenceMode()) return;

	const { entries, duration } = getTimelineMarkerEntries();
	if (!duration) return;

	const fragment = document.createDocumentFragment();

	// Start/End Trimming Shading (solo mode, local times from markers or clip bounds)
	if (!isSequenceMode()) {
		const startMarker = entries.find(
			(m) => m.type === "in" || m.type === "start",
		);
		const endMarker = entries.find((m) => m.type === "out" || m.type === "end");
		const soloIn =
			startMarker && startMarker.startTime > 0
				? startMarker.startTime
				: typeof clipInTime !== "undefined" && clipInTime > 0
					? clipInTime
					: 0;
		const soloOut =
			endMarker && endMarker.startTime > 0 && endMarker.startTime < duration
				? endMarker.startTime
				: typeof clipOutTime !== "undefined" &&
						clipOutTime > 0 &&
						clipOutTime < duration
					? clipOutTime
					: 0;

		if (soloIn > 0) {
			const startPct = (soloIn / duration) * 100;
			const startShade = document.createElement("div");
			startShade.className =
				"absolute top-0 bottom-0 bg-black/40 dark:bg-black/60";
			startShade.style.left = "0%";
			startShade.style.width = `${startPct}%`;
			fragment.appendChild(startShade);
		}

		if (soloOut > 0 && soloOut < duration) {
			const endPct = (soloOut / duration) * 100;
			const endShade = document.createElement("div");
			endShade.className =
				"absolute top-0 bottom-0 bg-black/40 dark:bg-black/60";
			endShade.style.left = `${endPct}%`;
			endShade.style.width = `${100 - endPct}%`;
			fragment.appendChild(endShade);
		}
	} else {
		// Multi: per-row grey outside [clipIn, clipOut] lives on each track via
		// applySegmentWindow (.sequence-row-dim). Overlay only draws flush join cuts.
		const run = window.getActiveJoinRun?.();
		if (run?.segments && duration > 0) {
			for (let i = 1; i < run.segments.length; i += 1) {
				// Shared boundary: sequenceOffset(i) == end of segment i-1
				const boundaryPct = (run.segments[i].offset / duration) * 100;
				const joinLine = document.createElement("div");
				joinLine.className =
					"absolute top-0 bottom-0 w-0.5 bg-blue-500/70 dark:bg-blue-400/60 z-10";
				joinLine.style.left = `${boundaryPct}%`;
				joinLine.title = "Join boundary";
				fragment.appendChild(joinLine);
			}
		}
	}

	// Loop through markers sequentially
	for (let i = 0; i < entries.length; i += 1) {
		const marker = entries[i];
		const markerLeft = (marker.startTime / duration) * 100;

		// Jump Skipping Shading
		if (marker.type === "jump") {
			const nextMarker = entries[i + 1];
			const endTime = nextMarker ? nextMarker.startTime : duration;
			const endPct = (endTime / duration) * 100;
			const widthPct = endPct - markerLeft;
			if (widthPct > 0) {
				const jumpShade = document.createElement("div");
				jumpShade.className =
					"absolute top-0 bottom-0 bg-zinc-500/20 dark:bg-zinc-900/40";
				jumpShade.style.left = `${markerLeft}%`;
				jumpShade.style.width = `${widthPct}%`;
				fragment.appendChild(jumpShade);
			}
		}

		// Loop sequence highlight span
		if (marker.type === "loop") {
			const nextMarker = entries[i + 1];
			const endTime = nextMarker ? nextMarker.startTime : duration;
			const endPct = (endTime / duration) * 100;
			const widthPct = endPct - markerLeft;
			if (widthPct > 0) {
				const loopShade = document.createElement("div");
				loopShade.className =
					"absolute top-0 bottom-0 bg-cyan-500/10 dark:bg-cyan-400/10";
				loopShade.style.left = `${markerLeft}%`;
				loopShade.style.width = `${widthPct}%`;
				fragment.appendChild(loopShade);
			}
		}

		// Create line element
		const lineElement = document.createElement("div");
		lineElement.style.left = `${markerLeft}%`;

		if (
			marker.type === "in" ||
			marker.type === "start" ||
			marker.type === "out" ||
			marker.type === "end" ||
			marker.type === "jump"
		) {
			lineElement.className =
				"absolute top-0 bottom-0 w-[2px] bg-zinc-400 dark:bg-zinc-500 z-10";
		} else if (marker.type === "loop") {
			lineElement.className =
				"absolute top-0 bottom-0 w-[2px] bg-cyan-500 dark:bg-cyan-400 z-10";
		} else {
			// normal annotation marker
			lineElement.className =
				"absolute top-0 bottom-0 w-[2px] bg-amber-500 dark:bg-yellow-400 z-10";
		}

		fragment.appendChild(lineElement);
	}

	overlay.appendChild(fragment);
};

/**
 * Wire zoom slider / Fit control once. Safe to call multiple times.
 */
const initTimelineZoomControls = () => {
	if (window._timelineZoomControlsBound) return;
	const slider = document.getElementById("timelineZoomSlider");
	if (!slider) return;
	window._timelineZoomControlsBound = true;

	const applyFromSlider = (fromUser) => {
		const v = Number.parseFloat(slider.value);
		setTimelineZoom(v, { fromUser: !!fromUser, regenerate: true });
	};

	slider.addEventListener("input", () => {
		// Live layout (width) without waiting for regen
		window._timelineZoom.factor = Number.parseFloat(slider.value) || 1;
		if (window._timelineZoom.factor > 1.001) {
			window._timelineZoom.userOverride = true;
		} else {
			window._timelineZoom.userOverride = false;
		}
		applyTimelineZoomLayout();
		const label = document.getElementById("timelineZoomLabel");
		const f = window._timelineZoom.factor;
		if (label) {
			label.textContent = f <= 1.001 ? "Fit" : `${f.toFixed(f >= 2 ? 1 : 2)}×`;
		}
	});
	slider.addEventListener("change", () => applyFromSlider(true));
	slider.addEventListener("dblclick", (e) => {
		e.preventDefault();
		resetTimelineZoomToFit();
	});

	document
		.getElementById("timelineZoomInBtn")
		?.addEventListener("click", () => {
			const cur = window._timelineZoom.factor || 1;
			setTimelineZoom(Math.min(TIMELINE_ZOOM_MAX, cur + 0.25), {
				fromUser: true,
				regenerate: true,
			});
		});
	document
		.getElementById("timelineZoomOutBtn")
		?.addEventListener("click", () => {
			const cur = window._timelineZoom.factor || 1;
			setTimelineZoom(Math.max(TIMELINE_ZOOM_MIN, cur - 0.25), {
				fromUser: true,
				regenerate: true,
			});
		});
	document
		.getElementById("timelineZoomFitBtn")
		?.addEventListener("click", () => {
			resetTimelineZoomToFit();
		});

	// Shift + wheel over timeline pans horizontally when zoomed
	const port = getTimelineScrollport();
	if (port && !port.dataset.shiftWheelBound) {
		port.dataset.shiftWheelBound = "1";
		port.addEventListener(
			"wheel",
			(e) => {
				if (!e.shiftKey) return;
				if ((window._timelineZoom?.factor || 1) <= 1.001) return;
				e.preventDefault();
				port.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
			},
			{ passive: false },
		);
	}

	// Window resize: recompute fit width; keep zoom factor if user zoomed
	if (!window._timelineZoomResizeBound) {
		window._timelineZoomResizeBound = true;
		let resizeTimer = null;
		window.addEventListener("resize", () => {
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				const wasFit = !window._timelineZoom.userOverride;
				applyTimelineZoomLayout({ forceFit: wasFit });
				// Light re-paint of ruler/markers; debounce heavy regen
				const dur = getTimelineDuration();
				if (dur > 0) {
					paintTimelineRuler(dur);
					if (typeof window.paintTimelineMarkersAndShading === "function") {
						window.paintTimelineMarkersAndShading();
					}
				}
				if (window._timelineZoomRegenTimer) {
					clearTimeout(window._timelineZoomRegenTimer);
				}
				window._timelineZoomRegenTimer = setTimeout(() => {
					window._timelineZoomRegenTimer = null;
					if (typeof window.loadWaveformTimeline === "function") {
						window.loadWaveformTimeline();
					}
				}, 250);
			}, 120);
		});
	}

	applyTimelineZoomLayout();
};

window.initTimelineZoomControls = initTimelineZoomControls;
window.syncTimelinePlayheadSmoothly = syncTimelinePlayheadSmoothly;
window.paintTimelineRuler = paintTimelineRuler;
window.setupVideoTrack = setupVideoTrack;
window.setupSequenceTracks = setupSequenceTracks;
window.renderAudioWaveformCanvas = renderAudioWaveformCanvas;
window.renderWaveformInto = renderWaveformInto;
window.paintTimelineMarkersAndShading = paintTimelineMarkersAndShading;

// Auto-bind when DOM is ready
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", () => {
		initTimelineZoomControls();
	});
} else {
	initTimelineZoomControls();
}
