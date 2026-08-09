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
			// totalDuration is already speed-warped per segment (join spine)
			if (run?.totalDuration > 0) return run.totalDuration;
		}
		return Math.max(window._sequenceMode?.totalDuration || 0, 0.001);
	}
	// Solo: FULL media length, speed-warped only — never clipIn..clipOut window
	if (typeof window.getActiveSpeedTimelineModel === "function") {
		const model = window.getActiveSpeedTimelineModel();
		if (model?.effectiveDuration > 0) {
			return Math.max(model.effectiveDuration, 0.001);
		}
		if (model?.mediaDuration > 0) {
			return Math.max(model.mediaDuration, 0.001);
		}
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
	// Solo: effective (speed-warped) time so playhead matches ruler
	if (typeof window.getActiveSpeedTimelineModel === "function") {
		const model = window.getActiveSpeedTimelineModel();
		const p = getPlayer();
		if (model?.hasSpeedMarkers && p) {
			return typeof window.sourceTimeToEffective === "function"
				? window.sourceTimeToEffective(p.currentTime || 0, model.ranges)
				: p.currentTime || 0;
		}
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
	if (!p) return;
	// Solo: timeline time is effective — map to source before seeking media
	if (
		typeof window.getActiveSpeedTimelineModel === "function" &&
		typeof window.effectiveTimeToSource === "function"
	) {
		const model = window.getActiveSpeedTimelineModel();
		if (model?.hasSpeedMarkers) {
			p.currentTime = window.effectiveTimeToSource(
				Math.max(0, Number(time) || 0),
				model.ranges,
			);
			return;
		}
	}
	p.currentTime = time;
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

		// Solo / last-in-run: stop at clipOut even when timeupdate is sparse
		if (
			typeof window.enforceClipOutStopOrHandoff === "function" &&
			window.enforceClipOutStopOrHandoff()
		) {
			window.lastCheckedVideoTime = player.currentTime;
			// Still update playhead % below after park
		} else if (currentVideoTime > window.lastCheckedVideoTime) {
			// Look-ahead intersection for jump markers (source-local)
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

	// Multi-join spine or speed-warped cells: keep block + absolute children
	const hasSegmentFill = !!videoTrack.querySelector(".sequence-segment-fill");
	const hasSpeedCells = !!videoTrack.querySelector(".sequence-speed-cell");
	if (
		hasSegmentFill ||
		hasSpeedCells ||
		videoTrack.dataset.sequenceSpine === "1"
	) {
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
	const aq =
		typeof activeQueueIndex !== "undefined"
			? activeQueueIndex
			: window.activeQueueIndex || 0;
	if (
		isSequenceMode() &&
		typeof window.getActiveJoinRun === "function" &&
		typeof window.sourceTimeToSequence === "function"
	) {
		const run = window.getActiveJoinRun();
		const entries = [];
		for (const seg of run.segments) {
			const sourceMarkers =
				seg.queueIndex === aq
					? markers || []
					: seg.video?.appState?.markers || [];
			for (let mi = 0; mi < sourceMarkers.length; mi += 1) {
				const marker = sourceMarkers[mi];
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
					_markerIndex: mi,
					_clipIn: seg.clipIn,
					_clipOut: seg.clipOut,
					_mediaDuration:
						Number(seg.video?.mediaDuration) ||
						Math.max(seg.clipOut || 0, seg.clipIn + (seg.duration || 0)),
				});
			}
		}
		entries.sort((a, b) => a.startTime - b.startTime);
		return { entries, duration };
	}
	// Solo: source-local times; paint maps to effective % when speed-warped
	// Timeline length is full media; clipIn/Out only for clamp of non-bound markers + shading
	const list = markers || [];
	const p = getPlayer();
	const speedModel =
		typeof window.getActiveSpeedTimelineModel === "function"
			? window.getActiveSpeedTimelineModel()
			: null;
	const mediaDur = Math.max(
		0,
		Number(speedModel?.mediaDuration) || 0,
		p?.duration || 0,
	);
	const soloIn =
		typeof clipInTime !== "undefined" ? Math.max(0, clipInTime) : 0;
	const soloOut =
		typeof clipOutTime !== "undefined" && clipOutTime > 0
			? clipOutTime
			: mediaDur;
	const entries = list.map((marker, mi) => ({
		...marker,
		startTime: marker.startTime,
		_localStartTime: marker.startTime,
		_queueIndex: aq,
		_markerIndex: mi,
		_clipIn: soloIn,
		_clipOut: soloOut > 0 ? soloOut : mediaDur,
		_mediaDuration: mediaDur,
	}));
	return { entries, duration };
};

/** Active marker drag on detailed timeline (null when idle). */
window._timelineMarkerDrag = null;

/**
 * Clamp a candidate source-local time for a marker.
 * Standard markers stay in [clipIn, clipOut]; in/out use Set Clip In/Out bounds.
 */
const clampMarkerLocalTime = (entry, localTime) => {
	let t = Math.max(0, Number(localTime) || 0);
	const mediaDur = Math.max(
		0,
		Number(entry._mediaDuration) || Number(entry._clipOut) || 0,
	);
	const clipIn = Math.max(0, Number(entry._clipIn) || 0);
	let clipOut = Math.max(0, Number(entry._clipOut) || 0);
	if (clipOut <= 0 && mediaDur > 0) clipOut = mediaDur;

	const type = entry.type || "standard";
	const isIn = type === "in" || type === "start";
	const isOut = type === "out" || type === "end";

	if (isIn) {
		// Same as Set Clip In: 0 .. current out (or media end)
		const maxT = clipOut > 0 ? clipOut : mediaDur > 0 ? mediaDur : t;
		t = Math.min(Math.max(0, t), Math.max(0, maxT));
	} else if (isOut) {
		// Same as Set Clip Out: clipIn .. media end
		const maxT = mediaDur > 0 ? mediaDur : Math.max(clipIn, t);
		t = Math.min(Math.max(clipIn, t), maxT);
	} else {
		// Annotation / jump / loop / speed: stay inside clip window
		const maxT = clipOut > 0 ? clipOut : mediaDur > 0 ? mediaDur : t;
		t = Math.min(Math.max(clipIn, t), Math.max(clipIn, maxT));
	}
	return t;
};

/**
 * Map timeline (effective/sequence) click time → source-local for a marker entry.
 */
const timelineTimeToMarkerLocal = (timelineTime, entry) => {
	const t = Math.max(0, Number(timelineTime) || 0);
	if (isSequenceMode() && typeof window.sequenceTimeToSource === "function") {
		const mapped = window.sequenceTimeToSource(t);
		if (mapped && mapped.queueIndex === entry._queueIndex) {
			return mapped.localTime;
		}
		// Outside this segment: clamp to segment edge via sequence map of entry's clip
		if (typeof window.sourceTimeToSequence === "function") {
			const run = window.getActiveJoinRun?.();
			const seg = run?.segments?.find(
				(s) => s.queueIndex === entry._queueIndex,
			);
			if (seg) {
				const segStart = seg.offset;
				const segEnd = seg.offset + seg.duration;
				if (t <= segStart) return entry._clipIn;
				if (t >= segEnd)
					return entry._clipOut > 0 ? entry._clipOut : entry._clipIn;
			}
		}
		return entry._localStartTime;
	}
	// Solo: timeline is effective when speed-warped
	if (
		typeof window.getActiveSpeedTimelineModel === "function" &&
		typeof window.effectiveTimeToSource === "function"
	) {
		const model = window.getActiveSpeedTimelineModel();
		if (model?.hasSpeedMarkers) {
			return window.effectiveTimeToSource(t, model.ranges);
		}
	}
	return t;
};

/**
 * Find marker list + index by stable id (or fallback index) after sorts.
 */
const resolveMarkerListIndex = (queueIndex, markerId, fallbackIndex) => {
	const aq =
		typeof activeQueueIndex !== "undefined"
			? activeQueueIndex
			: window.activeQueueIndex || 0;
	const list =
		queueIndex === aq
			? markers || []
			: typeof videoQueue !== "undefined" && videoQueue[queueIndex]?.appState
				? videoQueue[queueIndex].appState.markers || []
				: [];
	if (markerId != null && markerId !== "") {
		const byId = list.findIndex((m) => String(m.id) === String(markerId));
		if (byId >= 0) return { list, index: byId };
	}
	if (fallbackIndex >= 0 && fallbackIndex < list.length) {
		return { list, index: fallbackIndex };
	}
	return { list, index: -1 };
};

const endTimelineMarkerDrag = (persist) => {
	const drag = window._timelineMarkerDrag;
	if (!drag) return;
	if (drag._raf) {
		cancelAnimationFrame(drag._raf);
		drag._raf = null;
	}
	window._timelineMarkerDrag = null;
	document.body.classList.remove("timeline-marker-dragging");
	document.removeEventListener("pointermove", onTimelineMarkerPointerMove);
	document.removeEventListener("pointerup", onTimelineMarkerPointerUp);
	document.removeEventListener("pointercancel", onTimelineMarkerPointerUp);
	if (persist) {
		if (typeof saveLocalState === "function") saveLocalState();
		else if (typeof window.saveLocalState === "function") {
			window.saveLocalState();
		}
		// Final paint + table after clamp/sort settled
		if (typeof window.updateMarkersList === "function") {
			window.updateMarkersList();
		}
		if (typeof window.updateSliderTicks === "function") {
			window.updateSliderTicks();
		}
		if (typeof window.paintTimelineMarkersAndShading === "function") {
			window.paintTimelineMarkersAndShading();
		}
		const type = drag.type || "";
		const isBound =
			type === "in" || type === "out" || type === "start" || type === "end";
		if (isBound && typeof window.scheduleJoinTimelineRebuild === "function") {
			window.scheduleJoinTimelineRebuild();
		}
		if (
			type === "speed" &&
			typeof window.scheduleSpeedTimelineRebuild === "function"
		) {
			window.scheduleSpeedTimelineRebuild();
		}
	}
};

const flushTimelineMarkerDragVisuals = () => {
	const drag = window._timelineMarkerDrag;
	if (!drag) return;
	drag._raf = null;
	if (typeof window.updateMarkersList === "function") {
		window.updateMarkersList();
	}
	if (typeof window.paintTimelineMarkersAndShading === "function") {
		window.paintTimelineMarkersAndShading();
	}
	if (typeof window.updateSliderTicks === "function") {
		window.updateSliderTicks();
	}
};

const onTimelineMarkerPointerMove = (e) => {
	const drag = window._timelineMarkerDrag;
	if (!drag) return;
	e.preventDefault();
	const overlay = document.getElementById("timeline-marker-overlay");
	const timelineTime = timeFromTimelineClick(e.clientX, overlay);
	let localTime = timelineTimeToMarkerLocal(timelineTime, drag.entry);
	localTime = clampMarkerLocalTime(drag.entry, localTime);

	const { list, index } = resolveMarkerListIndex(
		drag.queueIndex,
		drag.markerId,
		drag.markerIndex,
	);
	if (index < 0 || !list[index]) return;

	// Write without full join rebuild mid-drag (spine rebuild on mouseup for in/out)
	list[index].startTime = localTime;
	list.sort((a, b) => a.startTime - b.startTime);
	const aq =
		typeof activeQueueIndex !== "undefined"
			? activeQueueIndex
			: window.activeQueueIndex || 0;
	if (
		drag.queueIndex === aq &&
		typeof videoQueue !== "undefined" &&
		videoQueue[drag.queueIndex]?.appState
	) {
		videoQueue[drag.queueIndex].appState.markers = markers;
	}
	// Keep entry clip bounds snapshot for continued clamping
	drag.entry._localStartTime = localTime;

	// Live-sync clipIn/Out so solo/last-in-run stop + grey zones track the drag
	const dragType = drag.type || list[index]?.type || "";
	const isBound =
		dragType === "in" ||
		dragType === "out" ||
		dragType === "start" ||
		dragType === "end";
	if (isBound && typeof window.syncClipBoundsFromMarkers === "function") {
		window.syncClipBoundsFromMarkers(drag.queueIndex);
		// Refresh clamp window from live globals after sync
		if (drag.queueIndex === aq) {
			if (typeof clipInTime !== "undefined") {
				drag.entry._clipIn = clipInTime;
			}
			if (typeof clipOutTime !== "undefined") {
				drag.entry._clipOut = clipOutTime;
			}
		}
	}

	// Coalesce live table + timeline paint to animation frames
	if (!drag._raf) {
		drag._raf = requestAnimationFrame(flushTimelineMarkerDragVisuals);
	}
};

const onTimelineMarkerPointerUp = (e) => {
	const drag = window._timelineMarkerDrag;
	if (!drag) return;
	if (
		e?.pointerId != null &&
		drag.pointerId != null &&
		e.pointerId !== drag.pointerId
	) {
		return;
	}
	// Final position from last move; optional one more sample
	if (e?.clientX != null) {
		onTimelineMarkerPointerMove(e);
	}
	// Sync clip bounds for in/out now that drag finished
	const type = drag.type || "";
	const isBound =
		type === "in" || type === "out" || type === "start" || type === "end";
	if (isBound && typeof window.syncClipBoundsFromMarkers === "function") {
		window.syncClipBoundsFromMarkers(drag.queueIndex);
	}
	endTimelineMarkerDrag(true);
};

const beginTimelineMarkerDrag = (e, entry) => {
	if (!entry) return;
	e.preventDefault();
	e.stopPropagation();
	// Drop any prior drag
	if (window._timelineMarkerDrag) {
		endTimelineMarkerDrag(false);
	}
	window._timelineMarkerDrag = {
		queueIndex: entry._queueIndex,
		markerIndex: entry._markerIndex,
		markerId: entry.id,
		type: entry.type || "standard",
		pointerId: e.pointerId,
		entry: { ...entry },
	};
	document.body.classList.add("timeline-marker-dragging");
	document.addEventListener("pointermove", onTimelineMarkerPointerMove);
	document.addEventListener("pointerup", onTimelineMarkerPointerUp);
	document.addEventListener("pointercancel", onTimelineMarkerPointerUp);
	try {
		e.currentTarget?.setPointerCapture?.(e.pointerId);
	} catch {
		// capture optional
	}
};

const paintTimelineMarkersAndShading = () => {
	const overlay = document.getElementById("timeline-marker-overlay");
	if (!overlay) return;
	// Keep handles interactive; shading children stay pointer-events-none
	overlay.style.pointerEvents = "none";
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

	// Start/End Trimming Shading (solo mode). Map to effective time when Speed warps the ruler.
	if (!isSequenceMode()) {
		const startMarker = entries.find(
			(m) => m.type === "in" || m.type === "start",
		);
		const endMarker = entries.find((m) => m.type === "out" || m.type === "end");
		const soloIn =
			startMarker && startMarker._localStartTime > 0
				? startMarker._localStartTime
				: typeof clipInTime !== "undefined" && clipInTime > 0
					? clipInTime
					: 0;
		const soloOut =
			endMarker && endMarker._localStartTime > 0
				? endMarker._localStartTime
				: typeof clipOutTime !== "undefined" && clipOutTime > 0
					? clipOutTime
					: 0;

		const speedModel =
			typeof window.getActiveSpeedTimelineModel === "function"
				? window.getActiveSpeedTimelineModel()
				: null;
		const toEff = (srcT) => {
			if (
				speedModel?.hasSpeedMarkers &&
				typeof window.sourceTimeToEffective === "function"
			) {
				return window.sourceTimeToEffective(srcT, speedModel.ranges);
			}
			return srcT;
		};
		const soloInEff = toEff(soloIn);
		const soloOutEff = soloOut > 0 ? toEff(soloOut) : 0;

		if (soloInEff > 0 && duration > 0) {
			const startPct = (soloInEff / duration) * 100;
			const startShade = document.createElement("div");
			startShade.className =
				"absolute top-0 bottom-0 bg-black/40 dark:bg-black/60 pointer-events-none";
			startShade.style.left = "0%";
			startShade.style.width = `${startPct}%`;
			fragment.appendChild(startShade);
		}

		if (soloOutEff > 0 && soloOutEff < duration) {
			const endPct = (soloOutEff / duration) * 100;
			const endShade = document.createElement("div");
			endShade.className =
				"absolute top-0 bottom-0 bg-black/40 dark:bg-black/60 pointer-events-none";
			endShade.style.left = `${endPct}%`;
			endShade.style.width = `${100 - endPct}%`;
			fragment.appendChild(endShade);
		}

		// Speed zones on effective timebase (2x sections are shorter; 1x has no tint)
		if (speedModel?.hasSpeedMarkers && speedModel.ranges?.length) {
			let effCursor = 0;
			const effDur = Math.max(0.001, speedModel.effectiveDuration || duration);
			for (const r of speedModel.ranges) {
				const rate = Math.max(0.01, Number(r.rate) || 1);
				const outSpan = Math.max(0, r.end - r.start) / rate;
				if (Math.abs(rate - 1) > 0.01 && outSpan > 0) {
					const left = (effCursor / effDur) * 100;
					const width = (outSpan / effDur) * 100;
					const speedShade = document.createElement("div");
					speedShade.className =
						"absolute top-0 bottom-0 bg-orange-500/10 dark:bg-orange-400/10 pointer-events-none";
					speedShade.style.left = `${left}%`;
					speedShade.style.width = `${width}%`;
					speedShade.title = `Speed ${
						typeof window.formatSpeedBadge === "function"
							? window.formatSpeedBadge(rate)
							: `${rate}x`
					}`;
					fragment.appendChild(speedShade);
				}
				effCursor += outSpan;
			}
		}
		// Fade zones are painted only on the filmstrip (refreshClipFadeTimelineZones),
		// not on this marker overlay — avoids double purple stacks.
	} else {
		// Multi: per-row grey outside [clipIn, clipOut] lives on each track via
		// applySegmentWindow (.sequence-row-dim). Overlay only draws flush join cuts.
		// Fade zones: filmstrip shells only (not overlay).
		const run = window.getActiveJoinRun?.();
		if (run?.segments && duration > 0) {
			for (let i = 1; i < run.segments.length; i += 1) {
				// Shared boundary: sequenceOffset(i) == end of segment i-1
				const boundaryPct = (run.segments[i].offset / duration) * 100;
				const joinLine = document.createElement("div");
				joinLine.className =
					"absolute top-0 bottom-0 w-0.5 bg-blue-500/70 dark:bg-blue-400/60 z-10 pointer-events-none";
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
					"absolute top-0 bottom-0 bg-zinc-500/20 dark:bg-zinc-900/40 pointer-events-none";
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
					"absolute top-0 bottom-0 bg-cyan-500/10 dark:bg-cyan-400/10 pointer-events-none";
				loopShade.style.left = `${markerLeft}%`;
				loopShade.style.width = `${widthPct}%`;
				fragment.appendChild(loopShade);
			}
		}

		// Create draggable handle — marker times mapped to effective % when speed-warped
		let lineLeftPct = (() => {
			if (
				!isSequenceMode() &&
				typeof window.getActiveSpeedTimelineModel === "function" &&
				typeof window.sourceTimeToEffective === "function"
			) {
				const model = window.getActiveSpeedTimelineModel();
				if (model?.hasSpeedMarkers && model.effectiveDuration > 0) {
					const eff = window.sourceTimeToEffective(
						marker._localStartTime ?? marker.startTime,
						model.ranges,
					);
					return (eff / model.effectiveDuration) * 100;
				}
			}
			return markerLeft;
		})();
		// Keep end/out handles inside the scrollport (100% + centered box was fully clipped)
		const isInBound = marker.type === "in" || marker.type === "start";
		const isOutBound = marker.type === "out" || marker.type === "end";
		if (isOutBound || lineLeftPct >= 99.5) {
			lineLeftPct = Math.min(lineLeftPct, 99.2);
		}
		if (isInBound || lineLeftPct <= 0.5) {
			lineLeftPct = Math.max(lineLeftPct, 0.8);
		}
		lineLeftPct = Math.max(0, Math.min(100, lineLeftPct));

		let stemBg = "bg-amber-500 dark:bg-yellow-400";
		let flagBorder = "border-amber-500 dark:border-yellow-400";
		let flagBg = "bg-amber-500 dark:bg-yellow-400";
		let handleZ = "z-20";
		if (isInBound || isOutBound) {
			// Clip bounds: distinct blue (matches seek-bar in/out ticks), above join lines
			stemBg = "bg-blue-500 dark:bg-blue-400";
			flagBorder = "border-blue-500 dark:border-blue-400";
			flagBg = "bg-blue-500 dark:bg-blue-400";
			handleZ = "z-30";
		} else if (marker.type === "jump") {
			stemBg = "bg-zinc-400 dark:bg-zinc-500";
			flagBorder = "border-zinc-400 dark:border-zinc-500";
			flagBg = "bg-zinc-400 dark:bg-zinc-500";
		} else if (marker.type === "loop") {
			stemBg = "bg-cyan-500 dark:bg-cyan-400";
			flagBorder = "border-cyan-500 dark:border-cyan-400";
			flagBg = "bg-cyan-500 dark:bg-cyan-400";
		} else if (marker.type === "speed") {
			stemBg = "bg-orange-500 dark:bg-orange-400";
			flagBorder = "border-orange-500 dark:border-orange-400";
			flagBg = "bg-orange-500 dark:bg-orange-400";
		}

		const handle = document.createElement("div");
		handle.className = `timeline-marker-handle absolute top-0 bottom-0 ${handleZ}`;
		handle.style.left = `${lineLeftPct}%`;
		handle.style.pointerEvents = "auto";
		handle.style.cursor = "ew-resize";
		const boundLabel = isInBound
			? "Clip In"
			: isOutBound
				? "Clip Out"
				: marker.name || "marker";
		handle.title = `Drag to adjust: ${boundLabel}`;
		handle.setAttribute("role", "slider");
		handle.setAttribute("aria-label", `Timeline marker ${boundLabel}`);
		handle.dataset.queueIndex = String(marker._queueIndex);
		handle.dataset.markerIndex = String(marker._markerIndex);
		if (marker.id != null) handle.dataset.markerId = String(marker.id);
		handle.dataset.markerType = marker.type || "standard";
		if (isOutBound) handle.dataset.clipBound = "out";
		if (isInBound) handle.dataset.clipBound = "in";

		// Vertical stem (visual only)
		const stem = document.createElement("div");
		stem.className = `timeline-marker-stem absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[2px] ${stemBg} pointer-events-none`;
		handle.appendChild(stem);

		// Flag head for hit target — larger for in/out so edge bounds stay grabable
		const flag = document.createElement("div");
		const flagSize = isInBound || isOutBound ? "w-3 h-3" : "w-2.5 h-2.5";
		flag.className = `timeline-marker-flag absolute top-0 left-1/2 -translate-x-1/2 ${flagSize} rounded-sm border-2 ${flagBorder} ${flagBg} pointer-events-none shadow-sm`;
		handle.appendChild(flag);

		const entrySnapshot = { ...marker };
		handle.addEventListener("pointerdown", (ev) => {
			if (ev.button != null && ev.button !== 0) return;
			beginTimelineMarkerDrag(ev, entrySnapshot);
		});
		// Block click-to-seek bubbling to filmstrip/ruler under the handle
		handle.addEventListener("click", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
		});

		fragment.appendChild(handle);
	}

	overlay.appendChild(fragment);

	// Also refresh per-track filmstrip fade zones (join shells + solo tracks)
	if (typeof window.refreshClipFadeTimelineZones === "function") {
		window.refreshClipFadeTimelineZones();
	}
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
