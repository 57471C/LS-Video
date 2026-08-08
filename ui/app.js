/**
 * @markdown
 * # AI CONTEXT MAP
 *
 * ## GLOBAL STATE STRUCTURE
 * - `videoQueue`: Array of objects representing the loaded videos. Each object contains metadata and state like `videoId`, `videoName`, `videoFileName`, `videoFilePath`, `clipInTime`, `clipOutTime`, and `appState` (which holds `markers`).
 * - `activeQueueIndex`: Integer representing the currently selected video slot in `videoQueue`.
 * - `markers`: Array of current active video markers (syncs back to `videoQueue[activeQueueIndex].appState.markers`).
 *
 * ## PERSISTENCE & LIFECYCLE
 * - `saveLocalState()`: Synchronizes memory (active globals like `videoFileName`, `clipInTime`, `markers`) back to the current `videoQueue` slot, and serializes the complete application state payload to `localStorage`.
 * - `loadLocalState()`: Rehydrates memory from `localStorage` on application mount, resolving `videoQueue` references to initialize the player.
 *
 * ## LEFT SIDEBAR ARCHITECTURE (Playlist UI)
 * - The new layout shifts away from modal drag-and-drop to a unified persistent side panel (`#playlist-queue-sidebar`).
 * - Render loops (`renderSidebarPlaylist`) rebuild the visual DOM nodes entirely based on `videoQueue` data.
 * - Interaction logic toggles active indices by swapping elements directly in the array (`videoQueue[index] = videoQueue[index+1]`) and forcing a re-render.
 */
import {
	initializeVideoViewportZoomPan,
	resetVideoViewport,
	updateViewportTransform,
} from "./js/viewport-engine.js";
import {
	initVisualizerAudio,
	isVisualizerActive,
	resizeVisualizer,
	startVisualizer,
	stopVisualizer,
} from "./js/visualizer-engine.js";

const isAudioOnlyMedia = (pathOrName) => {
	if (!pathOrName) return false;
	const lower = pathOrName.toLowerCase();
	return (
		lower.endsWith(".mp3") ||
		lower.endsWith(".wav") ||
		lower.endsWith(".flac") ||
		lower.endsWith(".aac") ||
		lower.endsWith(".m4a") ||
		lower.endsWith(".ogg") ||
		lower.endsWith(".wma")
	);
};

// ---------------------------------------------------------------------------
// Queue join / active-run sequence helpers (Phase 1)
// joinedToNext on queue item i means item i is joined to item i+1.
// ---------------------------------------------------------------------------
window._sequenceHandoffInProgress = false;
/** When true, handoff must resume play() after next source is ready (even if player already ended/paused). */
window._sequenceContinuePlay = false;
/** Soft handoff / sequence continue: skip mute-on-load and re-apply captured volume. */
window._softHandoffVolumeActive = false;
window._softHandoffAudio = null;
window._joinTimelineRebuildTimer = null;

/** Clamp transport volume to HTMLMediaElement range [0, 1]. */
const clampVolume01 = (v, fallback = 1) => {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(1, Math.max(0, n));
};

/** True when a queue item has an explicit per-clip volume (including 0). */
const queueItemHasOwnVolume = (video) =>
	!!video &&
	video.volumeLevel !== undefined &&
	video.volumeLevel !== null &&
	Number.isFinite(Number(video.volumeLevel));

/**
 * Resolve volume for a queue index: use that clip's remembered level if set,
 * otherwise walk backward and inherit the nearest previous clip's volume.
 * Falls back to current global volumeLevel.
 */
const resolveVolumeForQueueIndex = (index) => {
	const fallbackVol = clampVolume01(
		typeof volumeLevel !== "undefined" ? volumeLevel : 1,
		1,
	);
	const fallbackMuted =
		typeof player !== "undefined" && player ? !!player.muted : false;
	if (
		typeof videoQueue === "undefined" ||
		!videoQueue.length ||
		index === undefined ||
		index === null
	) {
		return { volume: fallbackVol, muted: fallbackMuted, sourceIndex: -1 };
	}
	const i0 = Math.max(0, Math.min(index, videoQueue.length - 1));
	for (let i = i0; i >= 0; i -= 1) {
		const v = videoQueue[i];
		if (queueItemHasOwnVolume(v)) {
			return {
				volume: clampVolume01(v.volumeLevel, fallbackVol),
				muted:
					v.volumeMuted !== undefined && v.volumeMuted !== null
						? !!v.volumeMuted
						: false,
				sourceIndex: i,
			};
		}
	}
	return { volume: fallbackVol, muted: fallbackMuted, sourceIndex: -1 };
};
window.resolveVolumeForQueueIndex = resolveVolumeForQueueIndex;

/** Persist volume/mute on a queue item (source-local). */
const rememberVolumeOnQueueIndex = (index, volume, muted) => {
	if (
		typeof videoQueue === "undefined" ||
		index < 0 ||
		index >= videoQueue.length ||
		!videoQueue[index]
	) {
		return;
	}
	videoQueue[index].volumeLevel = clampVolume01(volume, volumeLevel);
	if (muted !== undefined && muted !== null) {
		videoQueue[index].volumeMuted = !!muted;
	}
};
window.rememberVolumeOnQueueIndex = rememberVolumeOnQueueIndex;

/**
 * Apply volume + mute to player, global volumeLevel, and transport UI.
 * volumeSlider is 0–1 (not percent). volumeValue text is percent 0–100.
 */
const applyTransportVolume = (volume, muted) => {
	const vol = clampVolume01(volume, volumeLevel);
	const isMuted = !!muted;
	if (typeof player !== "undefined" && player) {
		player.volume = vol;
		player.muted = isMuted;
	}
	volumeLevel = vol;
	if (DOM?.volumeOnIcon && DOM?.volumeOffIcon) {
		DOM.volumeOnIcon.classList.toggle("hidden", isMuted);
		DOM.volumeOffIcon.classList.toggle("hidden", !isMuted);
	}
	if (typeof volumeSlider !== "undefined" && volumeSlider) {
		// Range input max=1 — never write percent (e.g. 10) or it clamps to 100%
		volumeSlider.value = isMuted ? 0 : vol;
	}
	if (DOM?.volumeValue) {
		DOM.volumeValue.textContent = isMuted ? "0" : String(Math.round(vol * 100));
	}
	return { volume: vol, muted: isMuted };
};
window.applyTransportVolume = applyTransportVolume;
window._sequenceMode = {
	active: false,
	totalDuration: 0,
	segments: [],
};

/**
 * Wait until the player can seek/play after a loadVideo swap.
 * Resolves on canplay/loadeddata or timeout so handoff never hangs forever.
 */
const waitForPlayerReadyToSeek = (videoEl, timeoutMs = 12000) =>
	new Promise((resolve) => {
		if (!videoEl) {
			resolve();
			return;
		}
		if (videoEl.readyState >= 2 && Number.isFinite(videoEl.duration)) {
			resolve();
			return;
		}
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			videoEl.removeEventListener("canplay", finish);
			videoEl.removeEventListener("loadeddata", finish);
			videoEl.removeEventListener("loadedmetadata", finish);
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		videoEl.addEventListener("canplay", finish);
		videoEl.addEventListener("loadeddata", finish);
		videoEl.addEventListener("loadedmetadata", finish);
	});

/**
 * Effective local end of the current clip for handoff/stop:
 * clipOut if set, else media duration.
 */
const getEffectiveClipOut = () => {
	if (clipOutTime > 0) return clipOutTime;
	if (typeof player !== "undefined" && player?.duration > 0) {
		return player.duration;
	}
	const q =
		typeof videoQueue !== "undefined" ? videoQueue[activeQueueIndex] : null;
	return Number(q?.mediaDuration) || 0;
};

/** True if playhead is at/past clip out or true media end (with small epsilon). */
const isAtOrPastClipOut = (currentTime) => {
	const out = getEffectiveClipOut();
	const mediaDur =
		typeof player !== "undefined" && player?.duration > 0 ? player.duration : 0;
	const epsilon = 0.05;
	if (out > 0 && currentTime >= out - epsilon) return true;
	if (mediaDur > 0 && currentTime >= mediaDur - epsilon) return true;
	if (typeof player !== "undefined" && player?.ended) return true;
	return false;
};

/** Whether current queue item should sequence-continue into the next. */
const shouldHandoffToNextJoined = () => {
	if (window._sequenceHandoffInProgress) return false;
	if (typeof videoQueue === "undefined" || !videoQueue.length) return false;
	if (activeQueueIndex >= videoQueue.length - 1) return false;
	const current = videoQueue[activeQueueIndex];
	if (!current?.joinedToNext) return false;
	const next = videoQueue[activeQueueIndex + 1];
	return !!next?.videoFilePath;
};

/** Effective media duration for a queue item (cached probe or active player). */
const getMediaDurationForQueueIndex = (video, queueIndex) => {
	if (!video) return 0;
	let d = Number(video.mediaDuration) || 0;
	if (
		d <= 0 &&
		queueIndex === activeQueueIndex &&
		typeof player !== "undefined" &&
		player?.duration
	) {
		d = player.duration || 0;
	}
	return d;
};

/** Effective clip out for a queue item (clipOut, mediaDuration, or active player). */
const getClipOutTime = (video, queueIndex) => {
	if (!video) return 0;
	let outT = Number(video.clipOutTime) || 0;
	if (outT <= 0) outT = getMediaDurationForQueueIndex(video, queueIndex);
	return outT;
};

/** Effective clip in for a queue item (default 0). */
const getClipInTime = (video) => {
	if (!video) return 0;
	return Math.max(0, Number(video.clipInTime) || 0);
};

/** Segment duration on the sequence spine: max(0, clipOut - clipIn). */
const getClipSegmentDuration = (video, queueIndex) => {
	if (!video) return 0;
	const inT = getClipInTime(video);
	const outT = getClipOutTime(video, queueIndex);
	return Math.max(0, outT - inT);
};

/** Default fade duration for Clip In/Out menu (0 = no fade until user sets one). */
export const FADE_DEFAULT_SEC = 0;
/** Hard ceiling so fades cannot swallow a long clip. */
export const FADE_HARD_MAX_SEC = 10;

/**
 * Normalize a fade duration to one decimal place; non-positive → 0.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeFadeSec(value) {
	const v = Number(value);
	if (!Number.isFinite(v) || v <= 0) return 0;
	return Math.round(v * 10) / 10;
}

/**
 * Clamp fade seconds: min 0, max min(10, half of clip duration).
 * @param {unknown} value
 * @param {number} [clipDurationSec=0]
 * @returns {number}
 */
export function clampFadeSec(value, clipDurationSec = 0) {
	let v = normalizeFadeSec(value);
	if (v <= 0) return 0;
	const dur = Math.max(0, Number(clipDurationSec) || 0);
	const maxByHalf = dur > 0 ? dur / 2 : FADE_HARD_MAX_SEC;
	const max = Math.min(FADE_HARD_MAX_SEC, maxByHalf);
	if (v > max) v = Math.round(max * 10) / 10;
	return v;
}

/**
 * Format fade badge text (e.g. "1.0s", "0.5s"). Empty when no fade.
 * @param {unknown} sec
 * @returns {string}
 */
export function formatFadeBadge(sec) {
	const v = normalizeFadeSec(sec);
	if (v <= 0) return "";
	return `${v.toFixed(1)}s`;
}

/**
 * Read / clamp fade pair for a queue item given its export duration.
 * @param {object|null|undefined} video
 * @param {number} [queueIndex]
 * @returns {{ fadeInSec: number, fadeOutSec: number }}
 */
export function getVideoFadeSeconds(video, queueIndex) {
	const dur =
		typeof getClipSegmentDuration === "function"
			? getClipSegmentDuration(video, queueIndex)
			: 0;
	return {
		fadeInSec: clampFadeSec(video?.fadeInSec, dur),
		fadeOutSec: clampFadeSec(video?.fadeOutSec, dur),
	};
}

/**
 * Set fade on the active (or given) queue item and persist.
 * @param {"in"|"out"} edge
 * @param {number|string} seconds
 * @param {number} [queueIndex]
 * @returns {number} Clamped value written
 */
export function setVideoFadeSec(edge, seconds, queueIndex = activeQueueIndex) {
	if (
		typeof videoQueue === "undefined" ||
		queueIndex < 0 ||
		!videoQueue[queueIndex]
	) {
		return 0;
	}
	const video = videoQueue[queueIndex];
	const dur = getClipSegmentDuration(video, queueIndex);
	const clamped = clampFadeSec(seconds, dur);
	if (edge === "out") {
		video.fadeOutSec = clamped;
	} else {
		video.fadeInSec = clamped;
	}
	if (typeof saveLocalState === "function") saveLocalState();
	// Live preview + timeline zones when active clip fades change
	if (queueIndex === activeQueueIndex) {
		if (typeof window.applyClipEdgeFadePreview === "function") {
			window.applyClipEdgeFadePreview();
		}
	}
	if (typeof window.paintTimelineMarkersAndShading === "function") {
		window.paintTimelineMarkersAndShading();
	}
	if (typeof window.refreshClipFadeTimelineZones === "function") {
		window.refreshClipFadeTimelineZones();
	}
	return clamped;
}
window.setVideoFadeSec = setVideoFadeSec;
window.formatFadeBadge = formatFadeBadge;
window.clampFadeSec = clampFadeSec;
window.getVideoFadeSeconds = getVideoFadeSeconds;
window.FADE_DEFAULT_SEC = FADE_DEFAULT_SEC;

// ---------------------------------------------------------------------------
// Speed markers — type "speed" + speedValue (playbackRate / export setpts)
// ---------------------------------------------------------------------------
/** Marker speed clamp (atempo-friendly). Matches common rates 0.25–4. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
export const SPEED_DEFAULT = 1.0;

/**
 * Clamp marker speed to [0.25, 4], round to 2 decimals.
 * @param {unknown} value
 * @returns {number}
 */
export function clampSpeedValue(value) {
	let v = Number(value);
	if (!Number.isFinite(v) || v <= 0) v = SPEED_DEFAULT;
	v = Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));
	return Math.round(v * 100) / 100;
}

/**
 * Badge text for Speed markers (e.g. "1.50x", "2x").
 * @param {unknown} value
 * @returns {string}
 */
export function formatSpeedBadge(value) {
	const v = clampSpeedValue(value);
	const s = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
	return `${s}x`;
}

/**
 * Active Speed marker: latest type===speed with startTime <= localTime within clip.
 * @param {Array} markersList
 * @param {number} localTime
 * @param {number} [clipIn=0]
 * @param {number} [clipOut=0]
 * @returns {{ marker: object, index: number, rate: number }|null}
 */
export function getActiveSpeedMarker(
	markersList,
	localTime,
	clipIn = 0,
	clipOut = 0,
) {
	const t = Number(localTime) || 0;
	const inT = Math.max(0, Number(clipIn) || 0);
	let outT = Math.max(0, Number(clipOut) || 0);
	const list = Array.isArray(markersList) ? markersList : [];
	let best = null;
	let bestIdx = -1;
	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		if (!m || m.type !== "speed") continue;
		const mt = Number(m.startTime) || 0;
		if (outT > inT && (mt < inT - 1e-3 || mt > outT + 1e-3)) continue;
		if (mt <= t + 1e-4 && (best == null || mt >= (Number(best.startTime) || 0))) {
			best = m;
			bestIdx = i;
		}
	}
	if (!best) return null;
	return {
		marker: best,
		index: bestIdx,
		rate: clampSpeedValue(best.speedValue ?? SPEED_DEFAULT),
	};
}

/**
 * Build contiguous speed ranges over [clipIn, clipOut] for export/playback.
 * Gaps before first Speed marker use rate 1.0.
 * @returns {Array<{ start: number, end: number, rate: number }>}
 */
export function buildSpeedRanges(markersList, clipIn, clipOut) {
	const inT = Math.max(0, Number(clipIn) || 0);
	let outT = Math.max(0, Number(clipOut) || 0);
	if (outT <= inT) return [{ start: inT, end: inT, rate: 1 }];
	const speeds = (Array.isArray(markersList) ? markersList : [])
		.filter((m) => m?.type === "speed")
		.map((m) => ({
			t: Math.max(inT, Math.min(outT, Number(m.startTime) || 0)),
			rate: clampSpeedValue(m.speedValue ?? SPEED_DEFAULT),
		}))
		.sort((a, b) => a.t - b.t);
	// Dedupe same-time markers (keep last)
	const deduped = [];
	for (const s of speeds) {
		if (deduped.length && Math.abs(deduped[deduped.length - 1].t - s.t) < 1e-4) {
			deduped[deduped.length - 1] = s;
		} else {
			deduped.push(s);
		}
	}
	const ranges = [];
	let cursor = inT;
	let rate = 1;
	// If a speed marker is exactly at clipIn, use it from the start
	if (deduped.length && Math.abs(deduped[0].t - inT) < 1e-4) {
		rate = deduped[0].rate;
	}
	for (const s of deduped) {
		if (s.t > cursor + 1e-4) {
			ranges.push({ start: cursor, end: s.t, rate });
			cursor = s.t;
		}
		rate = s.rate;
		cursor = Math.max(cursor, s.t);
	}
	if (cursor < outT - 1e-4) {
		ranges.push({ start: cursor, end: outT, rate });
	}
	if (ranges.length === 0) {
		ranges.push({ start: inT, end: outT, rate: 1 });
	}
	return ranges;
}

/**
 * Output (effective) duration of source ranges: sum((end-start)/rate).
 * Shared by export and timeline (10s, 2x@0, 1x@5 → 7.5s).
 */
export function getSpeedWarpedDuration(markersList, clipIn, clipOut) {
	const ranges = buildSpeedRanges(markersList, clipIn, clipOut);
	return ranges.reduce((sum, r) => {
		const span = Math.max(0, r.end - r.start);
		return sum + span / Math.max(0.01, r.rate);
	}, 0);
}

/**
 * Map source-local time → effective (output/timeline) time from clipIn.
 * Integral of dt/rate along speed runs.
 */
export function sourceTimeToEffective(localTime, ranges) {
	const t = Number(localTime) || 0;
	if (!Array.isArray(ranges) || ranges.length === 0) return Math.max(0, t);
	let eff = 0;
	for (const r of ranges) {
		const a = Number(r.start) || 0;
		const b = Number(r.end) || 0;
		const rate = Math.max(0.01, Number(r.rate) || 1);
		if (t <= a) break;
		if (t >= b) {
			eff += (b - a) / rate;
		} else {
			eff += (t - a) / rate;
			break;
		}
	}
	return Math.max(0, eff);
}

/**
 * Map effective (timeline) time → source-local time.
 */
export function effectiveTimeToSource(effectiveTime, ranges) {
	let rem = Math.max(0, Number(effectiveTime) || 0);
	if (!Array.isArray(ranges) || ranges.length === 0) return rem;
	for (const r of ranges) {
		const a = Number(r.start) || 0;
		const b = Number(r.end) || 0;
		const rate = Math.max(0.01, Number(r.rate) || 1);
		const outSpan = (b - a) / rate;
		if (rem <= outSpan + 1e-9) {
			return a + rem * rate;
		}
		rem -= outSpan;
	}
	const last = ranges[ranges.length - 1];
	return last ? Number(last.end) || 0 : 0;
}

/**
 * Active clip speed ranges + warped duration (shared playback / export / timeline).
 */
window.getActiveSpeedTimelineModel = () => {
	const qIndex =
		typeof activeQueueIndex === "number" ? activeQueueIndex : 0;
	const video =
		typeof videoQueue !== "undefined" ? videoQueue[qIndex] : null;
	const list =
		typeof markers !== "undefined" && Array.isArray(markers)
			? markers
			: video?.appState?.markers || [];
	const inT =
		typeof getClipInTime === "function"
			? getClipInTime(video)
			: Number(video?.clipInTime) || 0;
	let outT =
		typeof getClipOutTime === "function"
			? getClipOutTime(video, qIndex)
			: Number(video?.clipOutTime) || 0;
	const p =
		(typeof player !== "undefined" && player) || window.player || null;
	if (outT <= inT && p?.duration) outT = p.duration;
	const ranges = buildSpeedRanges(list, inT, outT > inT ? outT : inT);
	const effectiveDuration = getSpeedWarpedDuration(
		list,
		inT,
		outT > inT ? outT : inT,
	);
	return {
		queueIndex: qIndex,
		clipIn: inT,
		clipOut: outT > inT ? outT : inT,
		ranges,
		effectiveDuration: Math.max(0.001, effectiveDuration),
		hasSpeedMarkers: list.some((m) => m?.type === "speed"),
	};
};

/** Rebuild detailed timeline after Speed marker edits. */
window.scheduleSpeedTimelineRebuild = () => {
	if (window._speedTimelineRebuildTimer) {
		clearTimeout(window._speedTimelineRebuildTimer);
	}
	window._speedTimelineRebuildTimer = setTimeout(() => {
		window._speedTimelineRebuildTimer = null;
		if (typeof window.applyTimelineZoomLayout === "function") {
			window.applyTimelineZoomLayout();
		}
		if (typeof window.paintTimelineRuler === "function") {
			const model =
				typeof window.getActiveSpeedTimelineModel === "function"
					? window.getActiveSpeedTimelineModel()
					: null;
			const multi =
				typeof window.isActiveRunMulti === "function" &&
				window.isActiveRunMulti();
			if (multi && typeof window.getActiveJoinRun === "function") {
				const run = window.getActiveJoinRun();
				window.paintTimelineRuler(Math.max(0.001, run?.totalDuration || 0));
			} else if (model) {
				window.paintTimelineRuler(model.effectiveDuration);
			}
		}
		if (typeof window.paintTimelineMarkersAndShading === "function") {
			window.paintTimelineMarkersAndShading();
		}
		if (typeof window.loadWaveformTimeline === "function") {
			// Full rebuild so filmstrip/ruler match effective duration
			window.loadWaveformTimeline();
		} else if (typeof window.setupVideoTrack === "function") {
			window.setupVideoTrack();
		}
		if (typeof window.applyActiveSpeedPlayback === "function") {
			window.applyActiveSpeedPlayback();
		}
	}, 80);
};

/**
 * Apply playbackRate from active Speed marker (or global playbackSpeed if none).
 * Slider UI snaps to the governing rate.
 * Policy: dragging the slider while a Speed marker is active UPDATES that marker's
 * speedValue so export matches what you hear (see speedSlider handler).
 */
window.applyActiveSpeedPlayback = (opts = {}) => {
	const videoEl =
		(typeof player !== "undefined" && player) ||
		window.player ||
		document.getElementById("my_video");
	if (!videoEl) return 1;
	if (window._sequenceHandoffInProgress) return videoEl.playbackRate || 1;

	const qIndex =
		typeof activeQueueIndex === "number" ? activeQueueIndex : 0;
	const list =
		typeof markers !== "undefined" && Array.isArray(markers)
			? markers
			: videoQueue?.[qIndex]?.appState?.markers || [];
	const video = videoQueue?.[qIndex];
	const inT =
		typeof getClipInTime === "function"
			? getClipInTime(video)
			: Number(video?.clipInTime) || 0;
	let outT =
		typeof getClipOutTime === "function"
			? getClipOutTime(video, qIndex)
			: Number(video?.clipOutTime) || 0;
	if (outT <= 0 && videoEl.duration) outT = videoEl.duration;

	const t = Number(videoEl.currentTime) || 0;
	const active = getActiveSpeedMarker(list, t, inT, outT);
	const hasAnySpeed = list.some((m) => m?.type === "speed");
	let rate;
	if (active) {
		rate = active.rate;
		window._activeSpeedMarkerIndex = active.index;
	} else {
		window._activeSpeedMarkerIndex = -1;
		// No Speed marker covering playhead: free slider / global default
		rate = hasAnySpeed
			? 1
			: clampSpeedValue(
					typeof playbackSpeed !== "undefined" ? playbackSpeed : 1,
				);
	}

	if (Math.abs((videoEl.playbackRate || 1) - rate) > 0.001) {
		videoEl.playbackRate = rate;
	}
	// Snap transport slider to active rate (display only unless user drags)
	if (!opts.skipSlider) {
		const slider =
			typeof speedSlider !== "undefined" && speedSlider
				? speedSlider
				: document.getElementById("speedSlider");
		if (slider && Math.abs(Number(slider.value) - rate) > 0.001) {
			slider.value = String(rate);
		}
		if (DOM?.speedValue) {
			DOM.speedValue.textContent = `${rate.toFixed(rate % 1 === 0 ? 1 : 2)}x`;
		}
	}
	// Keep global playbackSpeed in sync when no marker governs (export default)
	if (!active && typeof playbackSpeed !== "undefined") {
		playbackSpeed = rate;
	}
	window._activeSpeedRate = rate;
	return rate;
};
window.getActiveSpeedMarker = getActiveSpeedMarker;
window.buildSpeedRanges = buildSpeedRanges;
window.getSpeedWarpedDuration = getSpeedWarpedDuration;
window.sourceTimeToEffective = sourceTimeToEffective;
window.effectiveTimeToSource = effectiveTimeToSource;
window.clampSpeedValue = clampSpeedValue;
window.formatSpeedBadge = formatSpeedBadge;
window.SPEED_MIN = SPEED_MIN;
window.SPEED_MAX = SPEED_MAX;
window.SPEED_DEFAULT = SPEED_DEFAULT;

/**
 * Compute linear fade gain (0..1) for local media time within [clipIn, clipOut].
 * @param {number} localTime
 * @param {number} clipIn
 * @param {number} clipOut
 * @param {number} fadeInSec
 * @param {number} fadeOutSec
 * @returns {number}
 */
export function computeClipEdgeFadeGain(
	localTime,
	clipIn,
	clipOut,
	fadeInSec,
	fadeOutSec,
) {
	const t = Number(localTime) || 0;
	const inT = Math.max(0, Number(clipIn) || 0);
	let outT = Math.max(0, Number(clipOut) || 0);
	const fi = Math.max(0, Number(fadeInSec) || 0);
	const fo = Math.max(0, Number(fadeOutSec) || 0);
	if (outT > 0 && outT <= inT) outT = inT;
	let gain = 1;
	// Outside active clip: fully faded (matches export bounds)
	if (t < inT - 1e-4) return 0;
	if (outT > inT && t > outT + 1e-4) return 0;
	if (fi > 0) {
		const endIn = inT + fi;
		if (t <= inT) gain = 0;
		else if (t < endIn) gain = Math.min(gain, (t - inT) / fi);
	}
	if (fo > 0 && outT > inT) {
		const startOut = outT - fo;
		if (t >= outT) gain = 0;
		else if (t > startOut) gain = Math.min(gain, (outT - t) / fo);
	}
	if (!Number.isFinite(gain)) return 1;
	return Math.max(0, Math.min(1, gain));
}
window.computeClipEdgeFadeGain = computeClipEdgeFadeGain;

/**
 * Shared fade-zone time ranges (source-local seconds).
 * Fade-in: [clipIn, clipIn+fadeInSec]; fade-out: [clipOut-fadeOutSec, clipOut].
 * Clamped to [clipIn, clipOut]. Returns null ranges when no fade / invalid bounds.
 * @returns {{ fadeIn: { start: number, end: number }|null, fadeOut: { start: number, end: number }|null, clipIn: number, clipOut: number }}
 */
export function computeClipFadeZoneRanges(
	clipIn,
	clipOut,
	fadeInSec,
	fadeOutSec,
) {
	const inT = Math.max(0, Number(clipIn) || 0);
	let outT = Math.max(0, Number(clipOut) || 0);
	if (outT <= inT) {
		return { fadeIn: null, fadeOut: null, clipIn: inT, clipOut: outT };
	}
	const activeDur = outT - inT;
	const fi = Math.min(Math.max(0, Number(fadeInSec) || 0), activeDur);
	const fo = Math.min(Math.max(0, Number(fadeOutSec) || 0), activeDur);
	return {
		clipIn: inT,
		clipOut: outT,
		fadeIn: fi > 1e-4 ? { start: inT, end: inT + fi } : null,
		fadeOut:
			fo > 1e-4
				? { start: Math.max(inT, outT - fo), end: outT }
				: null,
	};
}
window.computeClipFadeZoneRanges = computeClipFadeZoneRanges;

/** RAF id for smooth fade preview while playing. */
window._clipFadePreviewRaf = null;

/**
 * Apply live soft-fade preview on the player (opacity + volume).
 * Does not change volumeLevel / mute preference — only player.volume while fading.
 */
window.applyClipEdgeFadePreview = () => {
	const videoEl =
		(typeof player !== "undefined" && player) ||
		window.player ||
		document.getElementById("my_video");
	if (!videoEl) return;
	if (window._sequenceHandoffInProgress) return;

	const qIndex =
		typeof activeQueueIndex === "number" ? activeQueueIndex : 0;
	const video =
		typeof videoQueue !== "undefined" ? videoQueue[qIndex] : null;
	const fades =
		typeof getVideoFadeSeconds === "function"
			? getVideoFadeSeconds(video, qIndex)
			: {
					fadeInSec: Number(video?.fadeInSec) || 0,
					fadeOutSec: Number(video?.fadeOutSec) || 0,
				};
	const inT =
		typeof getClipInTime === "function"
			? getClipInTime(video)
			: Math.max(0, Number(video?.clipInTime) || 0);
	let outT =
		typeof getClipOutTime === "function"
			? getClipOutTime(video, qIndex)
			: Math.max(0, Number(video?.clipOutTime) || 0);
	if (outT <= 0 && videoEl.duration) outT = videoEl.duration;

	const gain = computeClipEdgeFadeGain(
		videoEl.currentTime,
		inT,
		outT,
		fades.fadeInSec,
		fades.fadeOutSec,
	);

	// Video opacity (visual fade)
	videoEl.style.opacity = String(gain);

	// Audio: scale user volume preference; never leave volumeLevel stuck at 0
	const baseVol = clampVolume01(
		typeof volumeLevel !== "undefined" ? volumeLevel : 1,
		1,
	);
	const userMuted = !!videoEl.muted;
	if (!userMuted) {
		videoEl.volume = baseVol * gain;
	}
	// If muted, leave volume alone (mute handles silence)
	window._clipFadePreviewGain = gain;
};

/** Start/stop RAF loop for smooth fade ramps during playback. */
window.ensureClipFadePreviewLoop = () => {
	const videoEl =
		(typeof player !== "undefined" && player) ||
		window.player ||
		document.getElementById("my_video");
	if (!videoEl) return;
	const tick = () => {
		window._clipFadePreviewRaf = null;
		if (typeof window.applyClipEdgeFadePreview === "function") {
			window.applyClipEdgeFadePreview();
		}
		if (videoEl && !videoEl.paused && !videoEl.ended) {
			window._clipFadePreviewRaf = requestAnimationFrame(tick);
		}
	};
	if (!videoEl.paused && !videoEl.ended) {
		if (!window._clipFadePreviewRaf) {
			window._clipFadePreviewRaf = requestAnimationFrame(tick);
		}
	} else if (window._clipFadePreviewRaf) {
		cancelAnimationFrame(window._clipFadePreviewRaf);
		window._clipFadePreviewRaf = null;
		if (typeof window.applyClipEdgeFadePreview === "function") {
			window.applyClipEdgeFadePreview();
		}
	}
};

/**
 * Paint fade-in / fade-out zone overlays on a host (filmstrip only — never audio / marker overlay).
 * Geometry from computeClipFadeZoneRanges:
 *   fade-in  [clipIn, clipIn+fi]
 *   fade-out [clipOut-fo, clipOut]
 * @param {HTMLElement} host
 * @param {{ clipIn: number, clipOut: number, fadeInSec: number, fadeOutSec: number, mediaRelative?: boolean, mediaDur?: number }} opts
 */
window.paintClipFadeZonesOnHost = (host, opts) => {
	if (!host) return;
	for (const old of host.querySelectorAll(".sequence-fade-zone")) {
		old.remove();
	}
	const ranges = computeClipFadeZoneRanges(
		opts?.clipIn,
		opts?.clipOut,
		opts?.fadeInSec,
		opts?.fadeOutSec,
	);
	if (!ranges.fadeIn && !ranges.fadeOut) return;

	const mediaRelative = !!opts?.mediaRelative;
	const activeDur = Math.max(0, ranges.clipOut - ranges.clipIn);
	if (activeDur <= 0) return;
	const mediaDur = Math.max(
		0.001,
		Number(opts?.mediaDur) ||
			(mediaRelative ? ranges.clipOut || activeDur : activeDur),
	);

	const addZone = (kind, startSec, endSec, title) => {
		// Hard clamp into [clipIn, clipOut] — never draw past clipOut into grey tail
		const start = Math.max(ranges.clipIn, Math.min(ranges.clipOut, startSec));
		const end = Math.max(ranges.clipIn, Math.min(ranges.clipOut, endSec));
		const span = Math.max(0, end - start);
		if (span <= 1e-4) return;
		let leftPct;
		let widthPct;
		if (mediaRelative) {
			// Full media clock (matches out marker + grey shade on timeline)
			leftPct = (start / mediaDur) * 100;
			widthPct = (span / mediaDur) * 100;
		} else {
			// Host is only the active [clipIn, clipOut] band
			leftPct = ((start - ranges.clipIn) / activeDur) * 100;
			widthPct = (span / activeDur) * 100;
		}
		if (widthPct <= 0.02) return;
		// Never let zone extend past clipOut on the host
		const maxRight =
			mediaRelative
				? (ranges.clipOut / mediaDur) * 100
				: 100;
		if (leftPct + widthPct > maxRight + 0.001) {
			widthPct = Math.max(0, maxRight - leftPct);
		}
		if (widthPct <= 0.02) return;
		const el = document.createElement("div");
		el.className = `sequence-fade-zone sequence-fade-zone-${kind}`;
		el.title = title;
		el.dataset.fadeStart = String(start);
		el.dataset.fadeEnd = String(end);
		el.style.cssText = `position:absolute;top:0;bottom:0;left:${leftPct}%;width:${widthPct}%;pointer-events:none;z-index:5;box-sizing:border-box;`;
		host.appendChild(el);
	};

	if (ranges.fadeIn) {
		const d = ranges.fadeIn.end - ranges.fadeIn.start;
		addZone(
			"in",
			ranges.fadeIn.start,
			ranges.fadeIn.end,
			`Fade in ${d.toFixed(1)}s`,
		);
	}
	// Fade-out: start at clipOut - fo (LEFT of out marker), end at clipOut — never start at clipOut
	if (ranges.fadeOut) {
		const d = ranges.fadeOut.end - ranges.fadeOut.start;
		addZone(
			"out",
			ranges.fadeOut.start,
			ranges.fadeOut.end,
			`Fade out ${d.toFixed(1)}s`,
		);
	}
};

/**
 * Single paint path for detailed-timeline fade zones.
 * Video filmstrip hosts only (not waveform/audio, not marker overlay).
 */
window.refreshClipFadeTimelineZones = () => {
	// Clear any stale zones on audio tracks / overlay (older double-paint)
	for (const stale of document.querySelectorAll(
		".sequence-audio-track .sequence-fade-zone, #timeline-marker-overlay .sequence-fade-zone",
	)) {
		stale.remove();
	}

	const run =
		typeof getActiveJoinRun === "function" ? getActiveJoinRun() : null;
	const multi = !!(run?.segments && run.segments.length > 1);

	if (multi) {
		for (const seg of run.segments) {
			const fades =
				typeof getVideoFadeSeconds === "function"
					? getVideoFadeSeconds(seg.video, seg.queueIndex)
					: {
							fadeInSec: Number(seg.video?.fadeInSec) || 0,
							fadeOutSec: Number(seg.video?.fadeOutSec) || 0,
						};
			// Only video-track shells (class on parent track)
			const videoTracks = document.querySelectorAll(
				`.sequence-video-track .sequence-media-shell[data-queue-index="${seg.queueIndex}"]`,
			);
			for (const shell of videoTracks) {
				const mediaDur = Math.max(
					0.001,
					Number(shell.dataset.mediaDuration) ||
						Number(seg.video?.mediaDuration) ||
						seg.duration ||
						1,
				);
				window.paintClipFadeZonesOnHost(shell, {
					clipIn: Number(shell.dataset.clipIn) || seg.clipIn || 0,
					clipOut: Number(shell.dataset.clipOut) || seg.clipOut || 0,
					fadeInSec: fades.fadeInSec,
					fadeOutSec: fades.fadeOutSec,
					mediaRelative: true,
					mediaDur,
				});
			}
		}
		return;
	}

	// Solo: same media clock as out marker + grey tail (full source duration).
	// Do NOT map zones onto active-only filmstrip % — that parks fade-out at the
	// right edge of the track (into the post-clipOut grey). Use media-relative
	// [clipOut - fo, clipOut] so purple ends at the out line, left of the grey.
	const videoTrack = document.getElementById("timeline-video-track");
	if (!videoTrack || videoTrack.querySelector(".sequence-segment-fill")) {
		return;
	}
	const video =
		typeof videoQueue !== "undefined" ? videoQueue[activeQueueIndex] : null;
	const fades =
		typeof getVideoFadeSeconds === "function"
			? getVideoFadeSeconds(video, activeQueueIndex)
			: {
					fadeInSec: Number(video?.fadeInSec) || 0,
					fadeOutSec: Number(video?.fadeOutSec) || 0,
				};
	const inT =
		typeof getClipInTime === "function"
			? getClipInTime(video)
			: Number(video?.clipInTime) || 0;
	let outT =
		typeof getClipOutTime === "function"
			? getClipOutTime(video, activeQueueIndex)
			: Number(video?.clipOutTime) || 0;
	const p =
		(typeof player !== "undefined" && player) || window.player || null;
	if (outT <= inT && p?.duration) outT = p.duration;
	const mediaDur = Math.max(
		0.001,
		Number(video?.mediaDuration) || 0,
		Number(p?.duration) || 0,
		outT,
		inT + 0.001,
	);
	if (getComputedStyle(videoTrack).position === "static") {
		videoTrack.style.position = "relative";
	}
	window.paintClipFadeZonesOnHost(videoTrack, {
		clipIn: inT,
		clipOut: outT > inT ? outT : inT + 1,
		fadeInSec: fades.fadeInSec,
		fadeOutSec: fades.fadeOutSec,
		mediaRelative: true,
		mediaDur,
	});
};

/**
 * Derive clipIn/clipOut on a queue item from its in/out markers (and media duration).
 * sequenceOffset math depends on these fields staying in sync with marker types.
 * @param {number} [queueIndex]
 * @returns {boolean} true if clipIn or clipOut changed
 */
const syncClipBoundsFromMarkers = (queueIndex = activeQueueIndex) => {
	if (
		typeof videoQueue === "undefined" ||
		queueIndex < 0 ||
		!videoQueue[queueIndex]
	) {
		return false;
	}
	const video = videoQueue[queueIndex];
	if (!video.appState) video.appState = { markers: [] };
	const list =
		queueIndex === activeQueueIndex
			? typeof markers !== "undefined"
				? markers
				: video.appState.markers || []
			: video.appState.markers || [];

	const mediaDur = getMediaDurationForQueueIndex(video, queueIndex);
	const startMarker = list.find((m) => m.type === "in" || m.type === "start");
	const endMarker = list.find((m) => m.type === "out" || m.type === "end");

	const prevIn = Number(video.clipInTime) || 0;
	const prevOut = Number(video.clipOutTime) || 0;

	let newIn = startMarker ? Number(startMarker.startTime) || 0 : 0;
	if (newIn < 0) newIn = 0;

	let newOut = endMarker ? Number(endMarker.startTime) || 0 : 0;
	if (!endMarker || newOut <= 0) {
		// Default out = full media duration when unset
		newOut = mediaDur > 0 ? mediaDur : prevOut > 0 ? prevOut : 0;
	}
	if (mediaDur > 0 && newOut > mediaDur) newOut = mediaDur;
	if (newOut > 0 && newIn > newOut) newIn = 0;

	video.clipInTime = newIn;
	video.clipOutTime = newOut;
	if (mediaDur > 0) video.mediaDuration = mediaDur;

	// Keep fades within half-duration / 10s after bound changes
	const segDur = Math.max(0, newOut > newIn ? newOut - newIn : 0);
	video.fadeInSec = clampFadeSec(video.fadeInSec, segDur);
	video.fadeOutSec = clampFadeSec(video.fadeOutSec, segDur);

	if (queueIndex === activeQueueIndex) {
		clipInTime = newIn;
		clipOutTime = newOut;
	}

	return prevIn !== newIn || prevOut !== newOut;
};
window.syncClipBoundsFromMarkers = syncClipBoundsFromMarkers;

/** True if this index is part of a join (its flag or previous item's flag). */
const isQueueIndexJoined = (index) => {
	if (
		typeof videoQueue === "undefined" ||
		index < 0 ||
		index >= videoQueue.length
	) {
		return false;
	}
	if (videoQueue[index]?.joinedToNext) return true;
	if (index > 0 && videoQueue[index - 1]?.joinedToNext) return true;
	return false;
};
window.isQueueIndexJoined = isQueueIndexJoined;

/**
 * Contiguous join-run that contains activeQueueIndex.
 * Solo (no joins touching current) → single-item run.
 */
const getActiveJoinRun = () => {
	const empty = {
		startIndex: 0,
		endIndex: 0,
		segments: [],
		totalDuration: 0,
	};
	if (typeof videoQueue === "undefined" || !videoQueue.length) return empty;

	const n = videoQueue.length;
	const cur = Math.max(0, Math.min(activeQueueIndex || 0, n - 1));

	let start = cur;
	while (start > 0 && videoQueue[start - 1]?.joinedToNext) {
		start -= 1;
	}
	let end = cur;
	while (end < n - 1 && videoQueue[end]?.joinedToNext) {
		end += 1;
	}

	// Sequence spine (flush join boundaries), speed-warped:
	//   segmentDuration(i) = sum((span)/rate) over Speed runs in [clipIn, clipOut]
	//   (equals clipOut-clipIn when all rates are 1x)
	const segments = [];
	let offset = 0;
	for (let i = start; i <= end; i += 1) {
		const video = videoQueue[i];
		const clipIn = getClipInTime(video);
		const clipOutRaw = getClipOutTime(video, i);
		const sourceDuration = Math.max(0, (clipOutRaw || 0) - clipIn);
		const clipOut = clipOutRaw > 0 ? clipOutRaw : clipIn + sourceDuration;
		const marks =
			i === activeQueueIndex && typeof markers !== "undefined"
				? markers
				: video?.appState?.markers || [];
		const speedRanges =
			typeof buildSpeedRanges === "function"
				? buildSpeedRanges(marks, clipIn, clipOut)
				: [{ start: clipIn, end: clipOut, rate: 1 }];
		const duration = Math.max(
			0,
			typeof getSpeedWarpedDuration === "function"
				? getSpeedWarpedDuration(marks, clipIn, clipOut)
				: sourceDuration,
		);
		segments.push({
			queueIndex: i,
			video,
			offset,
			duration,
			sourceDuration,
			speedRanges,
			clipIn,
			clipOut,
			// Explicit sequence bounds for this segment window (effective time)
			seqIn: offset,
			seqOut: offset + duration,
		});
		offset += duration;
	}
	return {
		startIndex: start,
		endIndex: end,
		segments,
		totalDuration: offset,
	};
};
window.getActiveJoinRun = getActiveJoinRun;

/** True when the active join run has more than one clip. */
const isActiveRunMulti = () => {
	const run = getActiveJoinRun();
	return !!(run?.segments && run.segments.length > 1);
};
window.isActiveRunMulti = isActiveRunMulti;

/** Map sequence (effective) time → source queue index + local media time. */
const sequenceTimeToSource = (seqTime, run = null) => {
	const r = run || getActiveJoinRun();
	if (!r.segments.length) return null;
	const t = Math.max(0, Number(seqTime) || 0);
	for (let i = 0; i < r.segments.length; i += 1) {
		const seg = r.segments[i];
		const segEnd = seg.offset + seg.duration;
		const isLast = i === r.segments.length - 1;
		if (t < segEnd || isLast) {
			const localEff = Math.min(
				Math.max(0, t - seg.offset),
				Math.max(0, seg.duration),
			);
			const ranges =
				seg.speedRanges ||
				(typeof buildSpeedRanges === "function"
					? buildSpeedRanges(
							seg.video?.appState?.markers || [],
							seg.clipIn,
							seg.clipOut,
						)
					: null);
			const localTime =
				ranges && typeof effectiveTimeToSource === "function"
					? effectiveTimeToSource(localEff, ranges)
					: seg.clipIn + localEff;
			return {
				queueIndex: seg.queueIndex,
				localTime,
				segment: seg,
			};
		}
	}
	const last = r.segments[r.segments.length - 1];
	return {
		queueIndex: last.queueIndex,
		localTime: last.clipOut,
		segment: last,
	};
};
window.sequenceTimeToSource = sequenceTimeToSource;

/** Map source-local time → sequence (effective) time for a queue index in the active run. */
const sourceTimeToSequence = (queueIndex, localTime, run = null) => {
	const r = run || getActiveJoinRun();
	const seg = r.segments.find((s) => s.queueIndex === queueIndex);
	if (!seg) return Number(localTime) || 0;
	const ranges =
		seg.speedRanges ||
		(typeof buildSpeedRanges === "function"
			? buildSpeedRanges(
					seg.video?.appState?.markers || [],
					seg.clipIn,
					seg.clipOut,
				)
			: null);
	const localEff =
		ranges && typeof sourceTimeToEffective === "function"
			? sourceTimeToEffective(Number(localTime) || 0, ranges)
			: Math.max(0, (Number(localTime) || 0) - seg.clipIn);
	return seg.offset + localEff;
};
window.sourceTimeToSequence = sourceTimeToSequence;

/** Current playhead as sequence time (local when solo). */
const getSequencePlayheadTime = () => {
	const run = getActiveJoinRun();
	const local =
		typeof player !== "undefined" && player ? player.currentTime || 0 : 0;
	if (run.segments.length <= 1) return local;
	return sourceTimeToSequence(activeQueueIndex, local, run);
};
window.getSequencePlayheadTime = getSequencePlayheadTime;

/**
 * Relative seek that crosses join boundaries when the active run is multi-clip.
 * @param {number} deltaSeconds positive = forward
 */
const seekRelativeInActiveRun = async (deltaSeconds) => {
	if (typeof player === "undefined" || !player) return;
	const run = getActiveJoinRun();
	const multi = run.segments.length > 1;
	const wasPlaying = !player.paused;

	if (multi) {
		const seqT = getSequencePlayheadTime();
		const nextSeq = Math.max(
			0,
			Math.min(run.totalDuration || 0, seqT + deltaSeconds),
		);
		// Preserve play/pause; scrub-style sequence map handles source switch
		await seekSequenceTime(nextSeq, {
			play: wasPlaying,
			silent: true,
		});
		return;
	}

	// Solo: clipIn/Out constrained local seek (existing behaviour)
	const inT = clipInTime || 0;
	const outT =
		clipOutTime > 0
			? clipOutTime
			: player.duration > 0
				? player.duration
				: Number.POSITIVE_INFINITY;
	const target = player.currentTime + deltaSeconds;
	player.currentTime = Math.max(inT, Math.min(outT, target));
};
window.seekRelativeInActiveRun = seekRelativeInActiveRun;

/** Capture current video frame to cover black flash during join handoff load. */
const showHandoffFreezeFrame = () => {
	const videoEl =
		(typeof player !== "undefined" && player) ||
		document.getElementById("my_video") ||
		document.querySelector("video");
	const wrapper =
		document.getElementById("video-wrapper-id") || videoEl?.parentElement;
	if (!videoEl || !wrapper) return;

	let freeze = document.getElementById("video-handoff-freeze");
	if (!freeze) {
		freeze = document.createElement("canvas");
		freeze.id = "video-handoff-freeze";
		freeze.setAttribute("aria-hidden", "true");
		freeze.className = "video-handoff-freeze";
		wrapper.appendChild(freeze);
	}

	const w = videoEl.videoWidth || videoEl.clientWidth || 0;
	const h = videoEl.videoHeight || videoEl.clientHeight || 0;
	if (w < 2 || h < 2) {
		// No decodable frame yet — use opaque hold instead of black pop
		videoEl.style.opacity = "0";
		freeze.dataset.opacityHold = "1";
		freeze.style.display = "none";
		return;
	}

	try {
		freeze.width = w;
		freeze.height = h;
		const ctx = freeze.getContext("2d");
		ctx.drawImage(videoEl, 0, 0, w, h);
		freeze.style.display = "block";
		freeze.dataset.opacityHold = "0";
		// Keep last frame visible while next source buffers
		videoEl.style.opacity = "0";
	} catch (err) {
		console.warn("[Playback] freeze frame capture failed:", err);
		videoEl.style.opacity = "0";
		freeze.dataset.opacityHold = "1";
	}
};

const hideHandoffFreezeFrame = () => {
	const videoEl =
		(typeof player !== "undefined" && player) ||
		document.getElementById("my_video") ||
		document.querySelector("video");
	const freeze = document.getElementById("video-handoff-freeze");
	if (videoEl) {
		videoEl.style.opacity = "";
	}
	if (freeze) {
		freeze.style.display = "none";
		try {
			const ctx = freeze.getContext("2d");
			ctx.clearRect(0, 0, freeze.width, freeze.height);
		} catch (_) {
			/* ignore */
		}
	}
};
window.showHandoffFreezeFrame = showHandoffFreezeFrame;
window.hideHandoffFreezeFrame = hideHandoffFreezeFrame;

/** Publish sequence mode snapshot for timeline-engine seek/playhead. */
const syncSequenceModeState = (run = null) => {
	const r = run || getActiveJoinRun();
	const multi = r.segments.length > 1;
	const playerDur =
		typeof player !== "undefined" && player?.duration ? player.duration : 0;
	window._sequenceMode = {
		active: multi,
		totalDuration: multi
			? Math.max(r.totalDuration, 0.001)
			: Math.max(playerDur || r.totalDuration || 0, 0.001),
		segments: r.segments,
	};
	const panel = document.getElementById("detailed-timeline-panel");
	const grid = document.getElementById("mainLayoutGrid");
	if (panel) panel.classList.toggle("sequence-multi", multi);
	if (grid) grid.classList.toggle("sequence-multi", multi);
	return window._sequenceMode;
};
window.syncSequenceModeState = syncSequenceModeState;

/** Debounced rebuild of detailed timeline after rapid join toggles (~175ms). */
const scheduleJoinTimelineRebuild = () => {
	if (window._joinTimelineRebuildTimer) {
		clearTimeout(window._joinTimelineRebuildTimer);
	}
	window._joinTimelineRebuildTimer = setTimeout(() => {
		window._joinTimelineRebuildTimer = null;
		// Re-sync all segment clip bounds from markers before measuring the spine
		if (typeof videoQueue !== "undefined" && videoQueue.length) {
			const run = getActiveJoinRun();
			for (const seg of run.segments) {
				if (typeof syncClipBoundsFromMarkers === "function") {
					syncClipBoundsFromMarkers(seg.queueIndex);
				}
			}
		}
		syncSequenceModeState();
		if (typeof window.loadWaveformTimeline === "function") {
			window.loadWaveformTimeline();
		}
		if (typeof window.updateMarkersList === "function") {
			window.updateMarkersList();
		}
		if (typeof window.paintTimelineMarkersAndShading === "function") {
			window.paintTimelineMarkersAndShading();
		}
		if (typeof updateSliderTicks === "function") {
			updateSliderTicks();
		}
	}, 175);
};
window.scheduleJoinTimelineRebuild = scheduleJoinTimelineRebuild;

const toggleJoinedToNext = (upperIndex) => {
	if (
		typeof videoQueue === "undefined" ||
		upperIndex < 0 ||
		upperIndex >= videoQueue.length - 1
	) {
		return;
	}
	const item = videoQueue[upperIndex];
	if (!item) return;
	item.joinedToNext = !item.joinedToNext;
	// Join does not change which clip is current
	if (typeof saveLocalState === "function") saveLocalState();
	if (typeof window.refreshSidebarPlaylist === "function") {
		window.refreshSidebarPlaylist();
	} else if (typeof window.renderSidebarPlaylist === "function") {
		window.renderSidebarPlaylist();
	}
	scheduleJoinTimelineRebuild();
};
window.toggleJoinedToNext = toggleJoinedToNext;

/**
 * Seek by sequence time: resolve source, switch queue slot if needed, seek local.
 * @param {number} seqTime
 * @param {{ play?: boolean, silent?: boolean }} [opts]
 */
const seekSequenceTime = async (seqTime, opts = {}) => {
	// play: true = force play, false = force pause, undefined = preserve prior state
	const { play, silent = true } = opts;
	const run = getActiveJoinRun();
	const mapped = sequenceTimeToSource(seqTime, run);
	if (!mapped) return;

	const wasPlaying = typeof player !== "undefined" && player && !player.paused;
	const shouldPlay = play === true ? true : play === false ? false : wasPlaying;
	const leavingIndex = activeQueueIndex;
	const leavingVol =
		typeof player !== "undefined" && player && Number.isFinite(player.volume)
			? player.volume
			: volumeLevel;
	const leavingMuted =
		typeof player !== "undefined" && player ? !!player.muted : false;
	let switchedSource = false;
	// Target audio: per-clip remembered volume, else inherit previous
	let targetAudio = {
		volume: leavingVol,
		muted: leavingMuted,
	};

	if (mapped.queueIndex !== activeQueueIndex) {
		switchedSource = true;
		// Remember volume on the clip we leave
		rememberVolumeOnQueueIndex(leavingIndex, leavingVol, leavingMuted);
		targetAudio = resolveVolumeForQueueIndex(mapped.queueIndex);
		// If target has no own volume, inherit the volume we just left with
		if (!queueItemHasOwnVolume(videoQueue[mapped.queueIndex])) {
			targetAudio = {
				volume: clampVolume01(leavingVol),
				muted: leavingMuted,
				sourceIndex: leavingIndex,
			};
		}
		window._softHandoffVolumeActive = true;
		window._softHandoffAudio = {
			volume: targetAudio.volume,
			muted: targetAudio.muted,
		};
		// Silent switch into target source without toast spam
		preserveClipBounds = true;
		if (typeof saveLocalState === "function") saveLocalState();
		activeQueueIndex = mapped.queueIndex;
		const currentVideo = videoQueue[activeQueueIndex];
		videoFileName = currentVideo.videoFileName || "";
		videoFilePath = currentVideo.videoFilePath || "";
		clipInTime = currentVideo.clipInTime || 0;
		clipOutTime = currentVideo.clipOutTime || 0;
		markers = currentVideo.appState?.markers || [];
		for (const m of markers) {
			if (!m.type) m.type = "standard";
		}
		if (typeof renderVideoQueueSelect === "function") renderVideoQueueSelect();
		if (typeof window.renderSidebarPlaylist === "function") {
			window.renderSidebarPlaylist();
		}
		if (typeof updateMarkersList === "function") updateMarkersList();
		if (typeof player !== "undefined" && player) player.pause();
		if (typeof window.resetClosedCaptions === "function") {
			window.resetClosedCaptions();
		}
		if (videoFilePath && typeof window.loadVideo === "function") {
			// Soft handoff when jump/scrub switches source mid-run
			showHandoffFreezeFrame();
			try {
				await window.loadVideo(videoFilePath, { softHandoff: true });
			} finally {
				// Hold freeze until seek+play decision below
			}
		}
		if (typeof player !== "undefined" && player) {
			await waitForPlayerReadyToSeek(player);
			applyTransportVolume(targetAudio.volume, targetAudio.muted);
		}
		if (!silent) {
			showToast(`Switched to: ${currentVideo.videoName}`, "success");
		}
	}

	if (typeof player !== "undefined" && player) {
		try {
			player.currentTime = mapped.localTime;
		} catch (err) {
			console.warn("[Playback] sequence seek failed:", err);
		}
		// Re-assert target audio after seek/play in case loadedmetadata raced
		if (switchedSource) {
			applyTransportVolume(targetAudio.volume, targetAudio.muted);
		}
		if (shouldPlay) {
			void player
				.play()
				?.catch((err) =>
					console.warn("[Playback] sequence seek play() blocked:", err),
				)
				.finally(() => {
					if (switchedSource) {
						applyTransportVolume(targetAudio.volume, targetAudio.muted);
					}
					// Reveal after a paint so first frame is more likely present
					requestAnimationFrame(() => hideHandoffFreezeFrame());
				});
		} else {
			player.pause();
			// Wait one frame so seek paints, then drop freeze
			requestAnimationFrame(() => {
				requestAnimationFrame(() => hideHandoffFreezeFrame());
			});
		}
	} else {
		hideHandoffFreezeFrame();
	}

	// Update playheads immediately in SEQUENCE time for multi-run
	const mode = syncSequenceModeState(run);
	const duration = mode.active ? mode.totalDuration : player?.duration || 1;
	const headTime = mode.active ? seqTime : mapped.localTime;
	const pct = duration > 0 ? (headTime / duration) * 100 : 0;
	const heads = document.getElementsByClassName("sequencer-playhead");
	for (let i = 0; i < heads.length; i += 1) {
		heads[i].style.left = `${pct}%`;
	}
	if (switchedSource) {
		window._softHandoffVolumeActive = false;
		window._softHandoffAudio = null;
	}
};
window.seekSequenceTime = seekSequenceTime;

/** Play across join: hand off to next queue item at its clipIn without stopping. */
const handoffToNextJoinedClip = async () => {
	if (window._sequenceHandoffInProgress) return;
	if (!shouldHandoffToNextJoined()) {
		// Unjoined or missing next — stop cleanly at out
		if (typeof player !== "undefined" && player && !player.paused) {
			player.pause();
		}
		const out = getEffectiveClipOut();
		if (typeof player !== "undefined" && player && out > 0) {
			try {
				player.currentTime = Math.min(out, player.duration || out);
			} catch (_) {
				/* ignore seek on dead element */
			}
		}
		window._sequenceContinuePlay = false;
		return;
	}

	window._sequenceHandoffInProgress = true;
	// Capture continue intent BEFORE load (ended/pause will clear player.paused)
	const resumeAfterLoad =
		window._sequenceContinuePlay ||
		(typeof player !== "undefined" && player && !player.paused);
	window._sequenceContinuePlay = true;

	// Capture leaving-clip audio, remember it, resolve target (own or inherit previous)
	const leavingIndex = activeQueueIndex;
	const handoffVolume =
		typeof player !== "undefined" && player && Number.isFinite(player.volume)
			? player.volume
			: volumeLevel;
	const handoffMuted =
		typeof player !== "undefined" && player ? !!player.muted : false;
	rememberVolumeOnQueueIndex(leavingIndex, handoffVolume, handoffMuted);

	const nextIndex = activeQueueIndex + 1;
	let targetAudio = resolveVolumeForQueueIndex(nextIndex);
	// Explicit inherit: if next has no remembered volume, keep leaving clip's level
	if (!queueItemHasOwnVolume(videoQueue[nextIndex])) {
		targetAudio = {
			volume: clampVolume01(handoffVolume),
			muted: handoffMuted,
			sourceIndex: leavingIndex,
		};
	}
	window._softHandoffVolumeActive = true;
	window._softHandoffAudio = {
		volume: targetAudio.volume,
		muted: targetAudio.muted,
	};

	try {
		const next = videoQueue[nextIndex];

		preserveClipBounds = true;
		if (typeof saveLocalState === "function") saveLocalState();

		activeQueueIndex = nextIndex;
		videoFileName = next.videoFileName || "";
		videoFilePath = next.videoFilePath || "";
		clipInTime = next.clipInTime || 0;
		clipOutTime = next.clipOutTime || 0;
		markers = next.appState?.markers || [];
		for (const m of markers) {
			if (!m.type) m.type = "standard";
		}

		if (typeof renderVideoQueueSelect === "function") renderVideoQueueSelect();
		if (typeof window.renderSidebarPlaylist === "function") {
			window.renderSidebarPlaylist();
		}
		if (typeof updateMarkersList === "function") updateMarkersList();
		// Drop prior captions; loadVideo will attach this source's VTT if present
		if (typeof window.clearSubtitleTracks === "function") {
			window.clearSubtitleTracks();
		}

		// Capture last frame before pause/src swap to hide black flash
		showHandoffFreezeFrame();

		// Soft pause only for the load gap — not a user "stop"
		if (typeof player !== "undefined" && player && !player.paused) {
			player.pause();
		}

		if (typeof window.loadVideo === "function") {
			await window.loadVideo(videoFilePath, { softHandoff: true });
		}

		if (typeof player !== "undefined" && player) {
			await waitForPlayerReadyToSeek(player);
			const targetIn = clipInTime || 0;
			try {
				player.currentTime = targetIn;
			} catch (err) {
				console.warn("[Playback] join handoff seek failed:", err);
			}
			// Apply target clip volume (own or inherited) — never force 100% / mute-on-load
			applyTransportVolume(targetAudio.volume, targetAudio.muted);
			// Refresh sequence mode so playhead uses run duration for next segment
			syncSequenceModeState();
			if (resumeAfterLoad || window._sequenceContinuePlay) {
				try {
					await player.play();
				} catch (err) {
					console.warn("[Playback] join handoff play() blocked:", err);
				}
				// Play can race with mute-on-load; re-assert once more after play
				applyTransportVolume(targetAudio.volume, targetAudio.muted);
			}
			// Drop freeze after paint of new source
			requestAnimationFrame(() => {
				requestAnimationFrame(() => hideHandoffFreezeFrame());
			});
			// Restart smooth playhead if play event did not
			if (
				!window.playheadAnimationId &&
				typeof window.syncTimelinePlayheadSmoothly === "function"
			) {
				window.playheadAnimationId = requestAnimationFrame(
					window.syncTimelinePlayheadSmoothly,
				);
			}
		} else {
			hideHandoffFreezeFrame();
		}

		syncSequenceModeState();
		// Playhead only — do NOT rebuild filmstrips/waveforms on sequence handoff
		if (typeof window.paintTimelineMarkersAndShading === "function") {
			window.paintTimelineMarkersAndShading();
		}
	} catch (err) {
		console.error("[Playback] join handoff failed:", err);
		hideHandoffFreezeFrame();
		if (typeof player !== "undefined" && player && !player.paused) {
			player.pause();
		}
	} finally {
		window._sequenceHandoffInProgress = false;
		window._sequenceContinuePlay = false;
		window._softHandoffVolumeActive = false;
		window._softHandoffAudio = null;
		// Next segment's own fadeInSec/fadeOutSec + Speed markers
		if (typeof window.applyClipEdgeFadePreview === "function") {
			window.applyClipEdgeFadePreview();
		}
		if (typeof window.ensureClipFadePreviewLoop === "function") {
			window.ensureClipFadePreviewLoop();
		}
		if (typeof window.applyActiveSpeedPlayback === "function") {
			window.applyActiveSpeedPlayback();
		}
	}
};
window.handoffToNextJoinedClip = handoffToNextJoinedClip;

// --- INITIAL THEME BOOTSTRAP (CSP-SAFE) ---
if (localStorage.getItem("darkMode") === "true") {
	document.documentElement.classList.add("dark");
} else {
	document.documentElement.classList.remove("dark");
}

const updateVisualizerControlsVisibility = () => {
	const vizToggleBtn = document.getElementById("vizToggleBtn");
	const vizCanvas = document.getElementById("vizCanvas");
	const isAudio = isAudioOnlyMedia(videoFilePath || videoFileName);

	if (isAudio) {
		if (vizToggleBtn) {
			vizToggleBtn.classList.remove("hidden");
			vizToggleBtn.disabled = false;
		}
	} else {
		if (vizToggleBtn) {
			vizToggleBtn.classList.add("hidden");
			vizToggleBtn.disabled = true;
			vizToggleBtn.classList.remove("btn-icon-highlight");
			vizToggleBtn.classList.add("btn-icon");
		}
		if (vizCanvas) {
			stopVisualizer(vizCanvas);
		}
		if (player) {
			player.classList.remove("opacity-0");
		}
	}
};

// --- CENTRAL APPLICATION RUNTIME STATE SAFETIES ---
window.cinemaIdleTimer = window.cinemaIdleTimer || null;
window.currentViewMode = window.currentViewMode || "normal"; // Valid options: 'normal', 'cinema', 'miniplayer'

// --- MARQUEE ZOOM COORDINATE POINTER SAFETIES ---
window.marqueeSelectionStartRef = null;
window.marqueeSelectionEndRef = null;

// 1. Global State Configuration & Element Cache Registries
const appWindow =
	window.__TAURI__?.window?.appWindow ||
	window.__TAURI__?.window?.getCurrentWindow?.() ||
	null;
const Command =
	window.__TAURI__?.shell?.Command ||
	window.__TAURI__?.pluginShell?.Command ||
	null;
const writeTextFile = window.__TAURI__?.fs?.writeTextFile || null;
const remove = window.__TAURI__?.fs?.remove || null;
const exists = window.__TAURI__?.fs?.exists || null;
// Tauri 2 path API (withGlobalTauri). Older code looked at os.tempdir — that is gone.
const tempDirFn =
	window.__TAURI__?.path?.tempDir ||
	window.__TAURI__?.path?.tempdir ||
	window.__TAURI__?.os?.tempdir ||
	null;
const joinPathFn = window.__TAURI__?.path?.join || null;
const openDialog = window.__TAURI__?.dialog?.open || null;

/** Write ffmpeg concat lists under $TEMP so fs scope always allows them. */
async function resolveFfmpegConcatListPath(fileName, fallbackBesideOutputPath) {
	if (tempDirFn) {
		try {
			const tempDir = await tempDirFn();
			if (joinPathFn) {
				return await joinPathFn(tempDir, fileName);
			}
			const sep = tempDir.endsWith("\\") || tempDir.endsWith("/") ? "" : "\\";
			return `${tempDir}${sep}${fileName}`;
		} catch (e) {
			console.warn(
				"tempDir unavailable for concat list; using fallback path",
				e,
			);
		}
	}
	if (fallbackBesideOutputPath) {
		const base = fallbackBesideOutputPath.substring(
			0,
			fallbackBesideOutputPath.lastIndexOf("."),
		);
		return `${base}_concat_list.txt`;
	}
	return fileName;
}
let player;
let loadVideoButton;
let addMarkerBtn;
let projectExportButton;
let projectSaveAsButton;
let projectImportButton;
let newProjectButton;
let packageBtn;
let speedSlider;
let seekBar;
let playPauseButton;
let jumpToStartButton;
let rewind5sButton;
let rewind1sButton;
let forward1sButton;
let forward5sButton;
let muteButton;
let volumeSlider;
let activeFFmpegChild = null;
let isAborted = false;
window.currentWaveformDataPath = null;

// Cache the live collection of playheads globally
const playheadsLiveCollection =
	document.getElementsByClassName("sequencer-playhead");
const batchVideoCheckboxesLive = document.getElementsByClassName(
	"batch-video-checkbox",
);
const selectionStart = { x: 0, y: 0 };
const selectionEnd = { x: 0, y: 0 };

// 2. Early Lifecycle Hooks (DOMContentLoaded, window.onload, and Tauri Launch Argument Handlers)
/** Single-line descriptor for onload. */
window.onload = () => {
	// Prevent horizontal scrolling/panning of the page in the Windows app
	document.documentElement.style.overflowX = "hidden";
	document.body.style.overflowX = "hidden";

	if (!playerReady) {
		initializePlayer();
	}

	if (!player?.src) {
		toggleVideoPlaceholder(true);
	}

	initializeTrimFeature();
};

document.addEventListener("DOMContentLoaded", () => {
	if (!playerReady) {
		initializePlayer();
	}

	const expandBtn = document.getElementById("expandToEditorBtn");
	if (expandBtn) {
		expandBtn.addEventListener("click", () => window.cycleViewMode("normal"));
	}

	const timelineToggleBtn = document.getElementById("timeline-toggle-btn");
	if (timelineToggleBtn) {
		timelineToggleBtn.addEventListener("click", () => {
			const mainGrid = document.getElementById("mainLayoutGrid");
			if (mainGrid) {
				mainGrid.classList.toggle("timeline-expanded");
				// Re-measure fit width after expand so zoom=1 fills the panel
				if (mainGrid.classList.contains("timeline-expanded")) {
					if (typeof window.initTimelineZoomControls === "function") {
						window.initTimelineZoomControls();
					}
					requestAnimationFrame(() => {
						if (typeof window.applyTimelineZoomLayout === "function") {
							const forceFit = !window._timelineZoom?.userOverride;
							window.applyTimelineZoomLayout({ forceFit });
						}
						if (
							typeof videoFilePath !== "undefined" &&
							videoFilePath &&
							typeof window.loadWaveformTimeline === "function"
						) {
							window.loadWaveformTimeline();
						}
					});
				}
			}
		});
	}
});

// Helpers for project data clearance and video loading
window.clearAllPreviousProjectData = () => {
	window.resetClosedCaptions();
	if (player) {
		player.pause();
		player.src = "";
		player.removeAttribute("src");
		try {
			player.load();
		} catch (e) {}
	}

	markers = [];
	videoFileName = "";
	preserveClipBounds = false;

	for (const key in videoBlobCache) {
		URL.revokeObjectURL(videoBlobCache[key]);
		delete videoBlobCache[key];
	}
	videoFilePath = "";
	projectFilePath = "";
	localStorage.removeItem("projectFilePath");
	localStorage.removeItem("lfvideo_project");
	localStorage.removeItem("timeStudyData"); // legacy key
	localStorage.removeItem("tmvideo_markers");
	localStorage.removeItem("tmvideo_project_metadata");
	projectName = "";
	projectComments = "";
	clipInTime = 0;
	clipOutTime = 0;

	videoQueue = [
		{
			videoId: 1,
			videoName: "Video 1",
			videoFileName: "",
			videoFilePath: "",
			clipInTime: 0,
			clipOutTime: 0,
			fadeInSec: 0,
			fadeOutSec: 0,
			joinedToNext: false,
			appState: { markers: [] },
		},
	];
	activeQueueIndex = 0;
	window._sequenceMode = { active: false, totalDuration: 0, segments: [] };

	if (DOM.projectNameInput) DOM.projectNameInput.value = "";

	if (DOM.videoPlaceholder) {
		DOM.videoPlaceholder.textContent = "Load a video to get started";
	}
	toggleVideoPlaceholder(true);
	if (typeof updateLoadButtonColor === "function") updateLoadButtonColor();
	if (typeof updateMarkersList === "function") updateMarkersList();

	// Hard visual reset of timeline graphics panels
	const tracksHost = document.getElementById("timeline-tracks-host");
	if (tracksHost) tracksHost.innerHTML = "";
	const videoTrack = document.getElementById("timeline-video-track");
	if (videoTrack) videoTrack.innerHTML = "";
	const audioTrack = document.getElementById("timeline-audio-track");
	if (audioTrack) audioTrack.innerHTML = "";
	const rulerTrack = document.getElementById("timeline-ruler-track");
	if (rulerTrack) rulerTrack.innerHTML = "";
	const overlayTrack = document.getElementById("timeline-marker-overlay");
	if (overlayTrack) overlayTrack.innerHTML = "";

	window.currentWaveformData = [];
	window.currentWaveformDataPath = null;
	window._sequenceMode = { active: false, totalDuration: 0, segments: [] };
	const mainGrid = document.getElementById("mainLayoutGrid");
	if (mainGrid) mainGrid.classList.remove("sequence-multi");
	const timelinePanel = document.getElementById("detailed-timeline-panel");
	if (timelinePanel) timelinePanel.classList.remove("sequence-multi");

	// Single project-reset path: keep queue UI and sliders in sync
	if (typeof renderVideoQueueSelect === "function") renderVideoQueueSelect();
	if (typeof window.refreshSidebarPlaylist === "function") {
		window.refreshSidebarPlaylist();
	} else if (typeof window.renderSidebarPlaylist === "function") {
		window.renderSidebarPlaylist();
	}
	window.currentProxyPath = null;
	if (typeof window.updateProxyInfoUi === "function") {
		window.updateProxyInfoUi(null);
	}
	if (typeof window.clearSubtitleTracks === "function") {
		window.clearSubtitleTracks();
	}
	saveLocalState();
	if (typeof updateSliderTicks === "function") updateSliderTicks();
};

/**
 * Canonical video load path for filesystem sources.
 * Always runs verify_and_prepare_video (H.265 proxy) before convertFileSrc.
 * Callers should set videoFileName/videoFilePath (source path) first when known;
 * this function backfills them when missing (e.g. drag-drop / launch args).
 *
 * Intentional exceptions that do NOT go through this helper:
 * - Blob/ObjectURL browser picks (no disk path; HTML5 only)
 * - HTTP(S) URL query param `?v=` rehydrate
 * - Clearing player.src on project reset / empty queue slot
 * - Post-export reload of an FFmpeg H.264/copy output (already playback-safe)
 */
/**
 * True when video.src is empty or only the app origin (no media path).
 * MediaError code 4 during load transitions is expected and must not toast.
 */
const isEmptyOrOriginOnlyMediaSrc = (src) => {
	if (!src || typeof src !== "string") return true;
	const trimmed = src.trim();
	if (!trimmed) return true;
	// Bare origin: http://127.0.0.1:1430/ or http://localhost:1420/
	try {
		const u = new URL(trimmed, window.location.href);
		const path = (u.pathname || "/").replace(/\/+$/, "") || "";
		if (
			(u.protocol === "http:" || u.protocol === "https:") &&
			(path === "" || path === "/") &&
			!u.search &&
			!u.hash
		) {
			return true;
		}
	} catch {
		// non-URL strings fall through
	}
	return false;
};

/**
 * Normalizes Windows extended prefixes (\\?\UNC\ and \\?\ prefixes) without stripping UNC network share paths (\\server\share\...).
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizePath(rawPath) {
	if (typeof rawPath !== "string" || !rawPath) return rawPath;
	const trimmed = rawPath.trim();
	let normalized = trimmed;
	const upper = trimmed.toUpperCase();

	if (upper.startsWith("\\\\?\\UNC\\")) {
		normalized = "\\\\" + trimmed.slice("\\\\?\\UNC\\".length);
	} else if (upper.startsWith("//?/UNC/")) {
		normalized = "//" + trimmed.slice("//?/UNC/".length);
	} else if (upper.startsWith("\\\\?\\")) {
		normalized = trimmed.slice("\\\\?\\".length);
	} else if (upper.startsWith("//?/")) {
		normalized = trimmed.slice("//?/".length);
	}

	console.log(`[Loader Core] Path normalize: "${rawPath}" -> "${normalized}"`);
	return normalized;
}

if (typeof window !== "undefined") {
	window.normalizePath = normalizePath;
}

/**
 * @param {string} incomingVideoPath
 * @param {{ softHandoff?: boolean }} [options]
 *   softHandoff: join handoff — skip hard timeline wipe (freeze frame covers video)
 */
window.loadVideo = async (incomingVideoPath, options = {}) => {
	if (!incomingVideoPath || incomingVideoPath.trim() === "") {
		console.error(
			"[Loader Core] Resource assignment blocked: empty path string.",
		);
		return;
	}

	const softHandoff = options?.softHandoff === true;
	const normalizedPath = normalizePath(incomingVideoPath);

	// Same path already loading — drop duplicate concurrent call (restore+open, etc.)
	if (window._videoLoadInProgress && window._loadVideoPath === normalizedPath) {
		return;
	}

	// Soft handoff / sequence seek must not wipe or regenerate filmstrips
	// (set only once we commit to a real load so a no-op return cannot sticky-skip)
	if (softHandoff) {
		window._skipNextTimelineBoot = true;
		window._softHandoffVolumeActive = true;
		// Capture audio state before src swap so loadedmetadata does not force mute
		const ve =
			document.querySelector("video") ||
			document.getElementById("video-player") ||
			document.getElementById("my_video") ||
			(typeof player !== "undefined" ? player : null);
		// Prefer existing capture (handoff may have stashed user state already)
		if (!window._softHandoffAudio) {
			if (ve) {
				window._softHandoffAudio = {
					volume: Number.isFinite(ve.volume) ? ve.volume : volumeLevel,
					muted: !!ve.muted,
				};
			} else {
				window._softHandoffAudio = {
					volume: volumeLevel,
					muted: false,
				};
			}
		}
	}

	window._videoLoadInProgress = true;
	window._loadVideoPath = normalizedPath;

	const clearLoadGuard = () => {
		// Only clear if this call still owns the slot (a different path may have taken over)
		if (window._loadVideoPath === normalizedPath) {
			window._videoLoadInProgress = false;
			window._loadVideoPath = null;
		}
	};

	// When true, clearLoadGuard is scheduled via setTimeout (success path)
	let settleViaTimeout = false;

	try {
		// Drop prior captions before media replace so source A cues never stick on B.
		// Soft handoff still clears tracks; loadSubtitleTrack reloads this source's VTT.
		if (typeof window.clearSubtitleTracks === "function") {
			window.clearSubtitleTracks();
		}

		// Hard visual reset of timeline graphics panels (skip during join soft-handoff)
		if (!softHandoff) {
			const tracksHost = document.getElementById("timeline-tracks-host");
			if (tracksHost) {
				tracksHost.innerHTML = "";
			}
			const videoTrack = document.getElementById("timeline-video-track");
			if (videoTrack) {
				videoTrack.innerHTML = "";
			}
			const audioTrack = document.getElementById("timeline-audio-track");
			if (audioTrack) {
				audioTrack.innerHTML = "";
			}
			const rulerTrack = document.getElementById("timeline-ruler-track");
			if (rulerTrack) {
				rulerTrack.innerHTML = "";
			}
			const overlayTrack = document.getElementById("timeline-marker-overlay");
			if (overlayTrack) {
				overlayTrack.innerHTML = "";
			}

			window.currentWaveformData = [];
			window.currentWaveformDataPath = null;
		}

		console.log(
			"[Loader Core] Processing absolute ingestion path parameter:",
			normalizedPath,
		);
		const optimizationOverlayNode =
			document.getElementById("optimizingOverlay");
		let resolvedFilePath = normalizedPath;
		let unlistenTranscode = null;

		// Resolve video element early so we can suppress errors during verify/swap
		const videoElement =
			document.querySelector("video") ||
			document.getElementById("video-player") ||
			document.getElementById("my_video") ||
			(typeof player !== "undefined" ? player : null);

		// Suppress transition noise while verify/proxy runs (before real URL is set)
		if (videoElement) {
			videoElement.onerror = null;
		}

		try {
			// Do not show the heavy optimizing overlay on load start (probe-only /
			// H.264 / cache-hit paths must not flash a spinner). Only reveal it when
			// the backend emits "transcode-needed" (AVI/HEVC first-time proxy).
			if (window.__TAURI__?.event?.listen) {
				unlistenTranscode = await window.__TAURI__.event.listen(
					"transcode-needed",
					() => {
						if (optimizationOverlayNode) {
							const titleEl = optimizationOverlayNode.querySelector("h3");
							const descEl = optimizationOverlayNode.querySelector("p");
							if (titleEl)
								titleEl.textContent = "Optimizing High-Efficiency Media";
							if (descEl)
								descEl.textContent =
									"Processing H.265/HEVC tracking sequences to generate a frame-accurate proxy timeline track. This occurs once per video asset. Please keep this window active...";
							optimizationOverlayNode.classList.remove("hidden");
							optimizationOverlayNode.classList.add("opacity-100", "flex");
						}
					},
				);
			}

			// Pass track path metrics down to our backend Rust transcoding checker command
			const invokeFn =
				window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
			if (invokeFn) {
				resolvedFilePath = await invokeFn("verify_and_prepare_video", {
					videoPath: normalizedPath,
				});
			}

			// Surgical clearance of native Windows extended UNC safety qualifiers
			resolvedFilePath = normalizePath(resolvedFilePath);
			console.log(
				"[Loader Core] Video path mapping successfully resolved to:",
				resolvedFilePath,
			);
		} catch (err) {
			console.error(
				"[Loader Core] Backend verification checker failed. Falling back to source:",
				err,
			);
			resolvedFilePath = normalizedPath;
		} finally {
			if (unlistenTranscode) {
				unlistenTranscode();
			}
			if (optimizationOverlayNode) {
				optimizationOverlayNode.classList.remove("opacity-100");
				setTimeout(() => {
					optimizationOverlayNode.classList.add("hidden");
					// Restore original copy for future runs
					const titleEl = optimizationOverlayNode.querySelector("h3");
					const descEl = optimizationOverlayNode.querySelector("p");
					if (titleEl) titleEl.textContent = "Optimizing High-Efficiency Media";
					if (descEl)
						descEl.textContent =
							"Processing H.265/HEVC tracking sequences to generate a frame-accurate proxy timeline track. This occurs once per video asset. Please keep this window active...";
				}, 300);
			}
		}

		// 3. Pin down the core HTML5 video rendering element tag
		if (!videoElement) {
			console.error(
				"[Loader Core] CRITICAL EXCEPTION: HTML5 <video> element missing from DOM grid structure.",
			);
			return;
		}

		// 4. Transform native drive references into authenticated network stream URLs
		// Playback uses the proxy path when HEVC/AVI; project globals keep the source path.
		let validatedStreamUrl = resolvedFilePath;
		if (window.__TAURI__) {
			const convertFn =
				window.__TAURI__.core?.convertFileSrc ||
				window.__TAURI__.tauri?.convertFileSrc;
			if (convertFn) {
				validatedStreamUrl = convertFn(resolvedFilePath);
			} else {
				validatedStreamUrl = `https://asset.localhost/${encodeURIComponent(resolvedFilePath)}`;
			}
		}

		console.warn(
			`%c[Loader Core] Pushing URL to hardware video track src: "${validatedStreamUrl}"`,
			"color: #00ffcc; font-weight: bold;",
		);

		// Sync globals: keep original source path for project save / subtitles / re-verify
		videoFilePath = normalizedPath;
		if (!videoFileName) {
			videoFileName = normalizedPath.split(/[/\\]/).pop() || "";
		}
		if (videoQueue[activeQueueIndex]) {
			videoQueue[activeQueueIndex].videoFilePath = videoFilePath;
			videoQueue[activeQueueIndex].videoFileName = videoFileName;
			// Track proxy path when verify_and_prepare returned a different file (H.265/AVI)
			const isProxy =
				resolvedFilePath &&
				normalizePath(resolvedFilePath) !== normalizedPath &&
				/proxy_[0-9a-f]+\.mp4$/i.test(
					String(resolvedFilePath).split(/[/\\]/).pop() || "",
				);
			videoQueue[activeQueueIndex].proxyPath = isProxy
				? normalizePath(resolvedFilePath)
				: null;
			window.currentProxyPath = videoQueue[activeQueueIndex].proxyPath;
			if (typeof window.updateProxyInfoUi === "function") {
				window.updateProxyInfoUi(videoQueue[activeQueueIndex].proxyPath);
			}
		}

		// Attach error tracking only after we have a real stream URL.
		// Suppress code 4 ONLY for empty/origin-only src — never solely for _videoLoadInProgress.
		videoElement.onerror = () => {
			const err = videoElement.error;
			const srcNow = videoElement.getAttribute("src") || videoElement.src || "";
			const code = err?.code;

			console.error(
				"[Loader Core] Browser multimedia layer rejected stream target!",
				err,
			);
			console.error(
				"[Loader Core] Attempted source URL string was:",
				videoElement.src,
			);

			// Benign: empty or origin-only URL during src swap (no media path yet)
			if (code === 4 && isEmptyOrOriginOnlyMediaSrc(srcNow)) {
				console.warn(
					"[Loader Core] Suppressing empty-src MediaError toast during load transition.",
				);
				return;
			}

			// Real failure
			if (typeof showToast === "function") {
				showToast(
					"Media engine failed to parse safe stream address URL",
					"error",
				);
			}
		};

		// 5. Fire core media track rehydration paint triggers
		const vizCanvas = document.getElementById("vizCanvas");
		if (isAudioOnlyMedia(normalizedPath)) {
			videoElement.classList.add("opacity-0");
		} else {
			videoElement.classList.remove("opacity-0");
			if (vizCanvas) {
				stopVisualizer(vizCanvas);
			}
		}
		videoElement.src = validatedStreamUrl;
		videoElement.preload = "auto";
		videoElement.load();
		updateVisualizerControlsVisibility();

		// Fire default post-load interface configurations
		if (typeof toggleVideoPlaceholder === "function") {
			toggleVideoPlaceholder(false);
		}
		if (typeof updateLoadButtonColor === "function") {
			updateLoadButtonColor();
		}
		if (typeof window.loadSubtitleTrack === "function") {
			window.loadSubtitleTrack(normalizedPath);
		}
		if (typeof window.repositionControls === "function") {
			setTimeout(window.repositionControls, 100);
		}

		// Delay clear slightly so media transition still sees in-progress guard
		settleViaTimeout = true;
		setTimeout(clearLoadGuard, 500);
	} catch (err) {
		console.error("[Loader Core] loadVideo failed:", err);
		throw err;
	} finally {
		// Immediate clear on early return / failure; success path uses delayed clear
		if (!settleViaTimeout) {
			clearLoadGuard();
		}
	}
};

window.initializeLaunchArgumentHandler = async () => {
	try {
		if (window.__TAURI__) {
			const launchPath = await window.__TAURI__.core.invoke(
				"get_launch_argument",
			);

			if (launchPath && launchPath.trim() !== "") {
				console.log("[Launch System] External OS file detected:", launchPath);
				const lower = launchPath.toLowerCase();

				// Unconditionally wipe all visual components on launch to prevent ghosting
				const videoTrack = document.getElementById("timeline-video-track");
				if (videoTrack) videoTrack.innerHTML = "";
				const audioTrack = document.getElementById("timeline-audio-track");
				if (audioTrack) audioTrack.innerHTML = "";
				const rulerTrack = document.getElementById("timeline-ruler-track");
				if (rulerTrack) rulerTrack.innerHTML = "";
				const overlayTrack = document.getElementById("timeline-marker-overlay");
				if (overlayTrack) overlayTrack.innerHTML = "";
				window.currentWaveformData = [];
				window.currentWaveformDataPath = null;

				if (
					lower.endsWith(".lsv") ||
					lower.endsWith(".lsvz") ||
					lower.endsWith(".tmv") ||
					lower.endsWith(".tmvz")
				) {
					try {
						projectFilePath = launchPath;
						localStorage.setItem("projectFilePath", projectFilePath);

						if (lower.endsWith(".lsvz") || lower.endsWith(".tmvz")) {
							const optimizationOverlayNode =
								document.getElementById("optimizingOverlay");
							if (optimizationOverlayNode) {
								const titleEl = optimizationOverlayNode.querySelector("h3");
								const descEl = optimizationOverlayNode.querySelector("p");
								if (titleEl)
									titleEl.textContent = "Extracting Project Archive...";
								if (descEl)
									descEl.textContent =
										"Unpacking compressed project folders, please wait...";
								optimizationOverlayNode.classList.remove("hidden");
								optimizationOverlayNode.classList.add("opacity-100", "flex");
							}

							try {
								const result = await window.__TAURI__.core.invoke(
									"load_tspz_bundle",
									{
										bundlePath: launchPath,
									},
								);

								// skipVideoLoad: paths in JSON point at original locations;
								// re-link to extracted temp paths before loading via proxy.
								importFromJSON(result.project_json, { skipVideoLoad: true });

								if (result.video_paths && result.video_paths.length > 0) {
									result.video_paths.forEach((tempPath, i) => {
										if (videoQueue[i]) {
											videoQueue[i].videoFilePath = tempPath;
											videoQueue[i].videoFileName = tempPath.replace(
												/^.*[\\/]/,
												"",
											);
										}
									});
									const active = videoQueue[activeQueueIndex];
									if (active?.videoFilePath) {
										videoFilePath = active.videoFilePath;
										videoFileName = active.videoFileName || "";
										await window.loadVideo(active.videoFilePath);
									}
									saveLocalState();
									renderVideoQueueSelect();
								}
							} finally {
								if (optimizationOverlayNode) {
									optimizationOverlayNode.classList.remove("opacity-100");
									setTimeout(() => {
										optimizationOverlayNode.classList.add("hidden");
										const titleEl = optimizationOverlayNode.querySelector("h3");
										const descEl = optimizationOverlayNode.querySelector("p");
										if (titleEl)
											titleEl.textContent = "Optimizing High-Efficiency Media";
										if (descEl)
											descEl.textContent =
												"Processing H.265/HEVC tracking sequences to generate a frame-accurate proxy timeline track. This occurs once per video asset. Please keep this window active...";
									}, 300);
								}
							}
						} else {
							const jsonText =
								await window.__TAURI__.fs.readTextFile(launchPath);
							await importFromJSON(jsonText);
						}

						toConsole(
							"Auto-loaded project from launch argument",
							launchPath,
							debuggin,
						);

						// RULE 1: Project files explicitly boot into maximized Normal workspace
						await window.cycleViewMode("normal");
					} catch (e) {
						toConsole("Error auto-loading project file", e, debuggin);
						showToast("Failed to auto-load project.", "error");
					}
				} else {
					// 1. CLEAR STALE LOCAL STORAGE PERSISTENCE GHOSTS
					localStorage.removeItem("tmvideo_markers");
					localStorage.removeItem("tmvideo_project_metadata");
					if (typeof window.clearAllPreviousProjectData === "function") {
						window.clearAllPreviousProjectData();
					} else if (typeof markers !== "undefined") {
						markers = [];
						if (typeof renderMarkersTable === "function") renderMarkersTable();
					}

					// 2. INGEST MEDIA STREAM ADDRESS TARGET URL
					if (typeof window.loadVideo === "function") {
						await window.loadVideo(launchPath);
					}

					// RULE 2: Raw media assets explicitly boot into floating Miniplayer widget
					await window.cycleViewMode("miniplayer");
				}
			} else {
				// RULE 1: Cold start without parameters MUST boot into Normal workspace mode
				await window.cycleViewMode("normal");
			}
		}
	} catch (error) {
		console.error(
			"[Launch System] Error initializing file launch constraints:",
			error,
		);
	}
};

if (window.__TAURI__ !== undefined) {
	document.addEventListener("DOMContentLoaded", () => {
		window.initializeLaunchArgumentHandler();
	});

	// WebView2 DevTools: Ctrl+Shift+I / F12 (enabled via tauri feature + window.devtools)
	document.addEventListener("keydown", (event) => {
		const isToggle =
			(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "i") ||
			event.key === "F12";
		if (!isToggle) return;
		try {
			const webview =
				window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.() ||
				window.__TAURI__?.webview?.getCurrentWebview?.() ||
				window.__TAURI__?.window?.getCurrentWindow?.();
			if (webview && typeof webview.openDevtools === "function") {
				event.preventDefault();
				webview.openDevtools();
			}
			// If openDevtools is unavailable, WebView2 still handles the shortcut natively
			// when the `devtools` feature and window.devtools config are enabled.
		} catch (e) {
			console.warn("DevTools toggle failed:", e);
		}
	});

	try {
		const currentActiveAppWindowInstance = window.__TAURI__.window
			.getCurrentWindow
			? window.__TAURI__.window.getCurrentWindow()
			: window.__TAURI__.window.appWindow;

		if (
			currentActiveAppWindowInstance &&
			typeof currentActiveAppWindowInstance.onDragDropEvent === "function"
		) {
			currentActiveAppWindowInstance.onDragDropEvent(
				(dragDropFilePayloadEvent) => {
					const payloadData = dragDropFilePayloadEvent.payload;

					if (
						payloadData &&
						payloadData.type === "drop" &&
						payloadData.paths &&
						payloadData.paths.length > 0
					) {
						const absoluteDroppedFilePathRef = payloadData.paths[0];
						console.log(
							"[DragDrop Subsystem] Caught OS file dropped directly onto app space grid wrapper:",
							absoluteDroppedFilePathRef,
						);

						if (typeof window.loadVideo === "function") {
							window.loadVideo(absoluteDroppedFilePathRef);
						}
					}
				},
			);
			console.log(
				"[DragDrop Subsystem] Native drag-drop hook tracking layers established successfully.",
			);
		}
	} catch (initializationFailureErr) {
		console.error(
			"[DragDrop Subsystem] Critical error mapping hardware window events:",
			initializationFailureErr,
		);
	}
}

// 3. Media Initialization & Streaming Event Subsystems
/**
 * CC button visual states (transport chrome):
 * - none: no VTT/tracks → dark/muted/disabled
 * - available: VTT present, captions OFF → normal/white idle
 * - active: VTT present, captions ON → green glow
 *
 * @param {"none"|"available"|"active"} state
 */
window.setCcButtonState = (state) => {
	const btn = document.getElementById("ccToggleBtn");
	const next =
		state === "active" || state === "available" || state === "none"
			? state
			: "none";

	window.ccAvailable = next !== "none";
	window.isCcActive = next === "active";
	window.captionsVisible = next === "active";

	if (!btn) return;

	btn.classList.remove(
		"btn-icon-cc-none",
		"btn-icon-cc-available",
		"btn-icon-cc-active",
		// legacy ad-hoc color classes
		"text-yellow-500",
		"dark:text-yellow-400",
		"text-zinc-400",
		"dark:text-zinc-600",
		"text-green-500",
		"dark:text-green-400",
		"text-white",
		"dark:text-white",
	);

	if (next === "none") {
		btn.classList.add("btn-icon-cc-none");
		btn.setAttribute("disabled", "true");
		btn.setAttribute("aria-pressed", "false");
		btn.setAttribute("aria-disabled", "true");
		btn.title = "Closed Captions (none available)";
	} else if (next === "available") {
		btn.classList.add("btn-icon-cc-available");
		btn.removeAttribute("disabled");
		btn.setAttribute("aria-pressed", "false");
		btn.setAttribute("aria-disabled", "false");
		btn.title = "Show Closed Captions";
	} else {
		// active
		btn.classList.add("btn-icon-cc-active");
		btn.removeAttribute("disabled");
		btn.setAttribute("aria-pressed", "true");
		btn.setAttribute("aria-disabled", "false");
		btn.title = "Hide Closed Captions";
	}
};

/**
 * Derive and apply CC button state from flags / player tracks.
 * @param {{ available?: boolean, active?: boolean }} [opts]
 */
window.updateCcButtonState = (opts = {}) => {
	let available =
		typeof opts.available === "boolean" ? opts.available : !!window.ccAvailable;
	let active =
		typeof opts.active === "boolean" ? opts.active : !!window.isCcActive;

	// Prefer live textTracks when not explicitly overridden
	if (opts.available === undefined || opts.active === undefined) {
		const videoEl =
			(typeof player !== "undefined" && player) ||
			document.getElementById("my_video") ||
			document.querySelector("video");
		if (videoEl?.textTracks?.length > 0) {
			let anyTrack = false;
			let anyShowing = false;
			for (let i = 0; i < videoEl.textTracks.length; i++) {
				const t = videoEl.textTracks[i];
				if (!t) continue;
				anyTrack = true;
				if (t.mode === "showing") anyShowing = true;
			}
			if (opts.available === undefined) available = anyTrack || available;
			if (opts.active === undefined) active = anyShowing;
		}
	}

	if (!available) {
		window.setCcButtonState("none");
	} else if (active) {
		window.setCcButtonState("active");
	} else {
		window.setCcButtonState("available");
	}
};

/**
 * Remove all <track> elements and disable textTracks on the player so old
 * captions cannot stick after media replace. Does NOT clear video.src.
 */
window.clearSubtitleTracks = () => {
	window.currentCaptions = [];
	window.ccAvailable = false;
	window.isCcActive = false;

	const videoPlayer =
		(typeof player !== "undefined" && player) ||
		document.querySelector("video") ||
		document.getElementById("my_video");
	if (videoPlayer) {
		// Disable first so the browser drops active cues immediately
		try {
			const tracks = videoPlayer.textTracks;
			for (let i = 0; i < tracks.length; i++) {
				tracks[i].mode = "disabled";
				// Clear cues when the browser exposes a mutable cue list
				const cueList = tracks[i].cues;
				if (cueList && typeof tracks[i].removeCue === "function") {
					while (cueList.length > 0) {
						try {
							tracks[i].removeCue(cueList[0]);
						} catch {
							break;
						}
					}
				}
			}
		} catch {
			/* ignore textTrack access races */
		}
		videoPlayer.querySelectorAll("track").forEach((trackNode) => {
			trackNode.remove();
		});
	}

	const ccDisplay = document.getElementById("cc-output");
	if (ccDisplay) {
		ccDisplay.innerHTML = "";
	}
	const transcriptContainer = document.getElementById("transcript-list");
	if (transcriptContainer) {
		transcriptContainer.innerHTML = "";
	}

	// Clear green + availability when CC is wiped on media change
	if (typeof window.setCcButtonState === "function") {
		window.setCcButtonState("none");
	}
};

/** Resets closed captions state and related local caches (also clears player src). */
window.resetClosedCaptions = () => {
	window.captionsVisible = true;

	// Clear waveform path so timeline reloads against the next media source
	window.currentWaveformDataPath = null;
	// Keep the custom detailed timeline mounted; only ensure the seek bar is visible
	const seekBarContainer = document.getElementById("seekBarContainer");
	if (seekBarContainer) {
		seekBarContainer.style.display = "block";
	}

	if (window.captionInterval) {
		clearInterval(window.captionInterval);
		window.captionInterval = null;
	}
	if (window.subInterval) {
		clearInterval(window.subInterval);
		window.subInterval = null;
	}

	// Caption / subtitle local caches (Whisper leftovers removed)
	localStorage.removeItem("captions");
	localStorage.removeItem("subtitles");
	localStorage.removeItem("transcript");
	sessionStorage.removeItem("captions");
	sessionStorage.removeItem("subtitles");

	if (window.indexedDB) {
		// Keep TMVideoDB purge for any prior installs; Whisper/Transcript DBs dropped
		const dbsToPurge = ["TMVideoDB", "captions", "subtitles"];
		for (const dbName of dbsToPurge) {
			try {
				const deleteRequest = window.indexedDB.deleteDatabase(dbName);
				deleteRequest.onsuccess = () => {
					if (window.TM_DEBUG_MODE) {
						console.log(
							`[Database System] Successfully purged offline database: ${dbName}`,
						);
					}
				};
			} catch (e) {
				console.warn("Database purge skipped for:", dbName, e);
			}
		}
	}

	for (let i = localStorage.length - 1; i >= 0; i--) {
		const key = localStorage.key(i);
		if (
			key &&
			(key.toLowerCase().includes("caption") ||
				key.toLowerCase().includes("sub") ||
				key.toLowerCase().includes("transcript") ||
				key.toLowerCase().includes("cue"))
		) {
			localStorage.removeItem(key);
		}
	}

	for (let i = sessionStorage.length - 1; i >= 0; i--) {
		const key = sessionStorage.key(i);
		if (
			key &&
			(key.toLowerCase().includes("caption") ||
				key.toLowerCase().includes("sub") ||
				key.toLowerCase().includes("transcript") ||
				key.toLowerCase().includes("cue"))
		) {
			sessionStorage.removeItem(key);
		}
	}

	window.clearSubtitleTracks();

	const videoPlayer =
		(typeof player !== "undefined" && player) ||
		document.querySelector("video");
	if (videoPlayer) {
		videoPlayer.pause();
		videoPlayer.src = "";
		try {
			videoPlayer.load(); // Forces the browser to flush the active buffer completely
		} catch (e) {
			// Ignore load error on empty src
		}
	}
};

/** Loads a subtitle track for the provided video path (sidecar .vtt / .srt). */
window.loadSubtitleTrack = async (filePath) => {
	// Always strip prior tracks so captions from the previous media cannot stick
	window.clearSubtitleTracks();

	const videoEl =
		(typeof player !== "undefined" && player) ||
		document.getElementById("my_video") ||
		document.querySelector("video");
	if (!videoEl || !filePath) {
		if (typeof window.setCcButtonState === "function") {
			window.setCcButtonState("none");
		}
		return;
	}

	const isTauri = window.__TAURI__ !== undefined;
	if (!isTauri) {
		if (typeof window.setCcButtonState === "function") {
			window.setCcButtonState("none");
		}
		return;
	}

	try {
		const vttPath = await window.__TAURI__.core.invoke("resolve_subtitles", {
			videoPath: filePath,
		});
		if (!vttPath) {
			// No sidecar — keep dark/disabled
			if (typeof window.setCcButtonState === "function") {
				window.setCcButtonState("none");
			}
			return;
		}

		const ccTrack = document.createElement("track");
		ccTrack.id = "ccTrack";
		ccTrack.kind = "captions";
		ccTrack.srclang = "en";
		ccTrack.label = "English";
		ccTrack.default = true;
		ccTrack.src = window.__TAURI__.core.convertFileSrc(vttPath);
		videoEl.appendChild(ccTrack);

		// Show immediately after successful resolve so state is available+active
		const showTracks = () => {
			for (let i = 0; i < videoEl.textTracks.length; i++) {
				const t = videoEl.textTracks[i];
				t.mode =
					t.label === "English" || t.label === "Generated Captions"
						? "showing"
						: "disabled";
			}
			if (typeof window.setCcButtonState === "function") {
				window.setCcButtonState("active");
			}
		};
		setTimeout(showTracks, 50);

		toConsole("Loaded subtitle track", vttPath, debuggin);
		// Available immediately; green once modes apply
		if (typeof window.setCcButtonState === "function") {
			window.setCcButtonState("active");
		}
		// No Whisper auto-caption fallback — sidecars via resolve_subtitles / save_vtt_file only
	} catch (err) {
		toConsole("Error resolving subtitles", err, debuggin);
		if (typeof window.setCcButtonState === "function") {
			window.setCcButtonState("none");
		}
	}
};

/**
 * Attach a known VTT file path to the player (after Generate CC write).
 * @param {string} vttFilePath absolute path to .vtt
 */
window.attachSubtitleTrackFromPath = (vttFilePath) => {
	window.clearSubtitleTracks();
	const videoEl =
		(typeof player !== "undefined" && player) ||
		document.getElementById("my_video") ||
		document.querySelector("video");
	if (!videoEl || !vttFilePath) {
		if (typeof window.setCcButtonState === "function") {
			window.setCcButtonState("none");
		}
		return;
	}

	const convertFn =
		window.__TAURI__?.core?.convertFileSrc ||
		window.__TAURI__?.tauri?.convertFileSrc;
	const src = convertFn
		? convertFn(vttFilePath)
		: `https://asset.localhost/${encodeURIComponent(vttFilePath)}`;

	const track = document.createElement("track");
	track.id = "ccTrack";
	track.kind = "captions";
	track.label = "Generated Captions";
	track.srclang = "en";
	track.default = true;
	track.src = src;
	videoEl.appendChild(track);

	const showTracks = () => {
		for (let i = 0; i < videoEl.textTracks.length; i++) {
			const t = videoEl.textTracks[i];
			t.mode =
				t.label === "Generated Captions" || t.label === "English"
					? "showing"
					: "disabled";
		}
		if (typeof window.setCcButtonState === "function") {
			window.setCcButtonState("active");
		}
	};
	setTimeout(showTracks, 50);

	// Generate CC path: track present and shown → green active
	if (typeof window.setCcButtonState === "function") {
		window.setCcButtonState("active");
	}
};

/** Browser download fallback when the video folder is not writable. */
window.downloadVttFallback = (vttContent, basename = "captions.vtt") => {
	try {
		const blob = new Blob([vttContent], { type: "text/vtt;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = basename.endsWith(".vtt") ? basename : `${basename}.vtt`;
		a.style.visibility = "hidden";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		return true;
	} catch (e) {
		console.error("[CC] Download fallback failed:", e);
		return false;
	}
};

/**
 * Ensure timeline tracks host has N video+audio row pairs for the active run.
 * Solo (1 segment) keeps classic #timeline-video-track / #timeline-audio-track ids.
 */
const ensureSequenceTrackRows = (segmentCount) => {
	const host = document.getElementById("timeline-tracks-host");
	if (!host) return [];

	host.innerHTML = "";
	const rows = [];

	for (let i = 0; i < segmentCount; i += 1) {
		const pair = document.createElement("div");
		pair.className = "sequence-av-pair";
		pair.dataset.segmentIndex = String(i);

		if (segmentCount > 1) {
			const label = document.createElement("div");
			label.className = "sequence-segment-label";
			label.dataset.segmentIndex = String(i);
			pair.appendChild(label);
		}

		const videoTrack = document.createElement("div");
		videoTrack.className =
			"w-full bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 border-dashed sequence-video-track";
		videoTrack.style.cssText =
			"height: 64px; width: 100%; position: relative; overflow: hidden; display: flex; align-items: stretch; justify-content: flex-start; box-sizing: border-box; font-size: 12px; border-radius: 4px;";
		if (i === 0) videoTrack.id = "timeline-video-track";
		videoTrack.dataset.segmentIndex = String(i);

		const audioTrack = document.createElement("div");
		audioTrack.className =
			"w-full bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 border-dashed sequence-audio-track";
		audioTrack.style.cssText =
			"height: 40px; position: relative; display: flex; align-items: center; justify-content: center; font-size: 12px; border-radius: 4px;";
		if (i === 0) audioTrack.id = "timeline-audio-track";
		audioTrack.dataset.segmentIndex = String(i);

		pair.appendChild(videoTrack);
		pair.appendChild(audioTrack);
		host.appendChild(pair);
		rows.push({ videoTrack, audioTrack, pair, segmentIndex: i });
	}
	return rows;
};

/**
 * Fill a track/fill element with filmstrip thumbs.
 * CRITICAL: for `.sequence-segment-fill`, do NOT set width:100% — that expands an
 * absolutely positioned segment to the full sequence spine (row-1 spill bug).
 */
const fillFilmstripTrack = (trackOrFill, thumbnailPaths) => {
	if (!trackOrFill || !thumbnailPaths?.length) return;

	const isSegmentFill = trackOrFill.classList.contains("sequence-segment-fill");
	// Preserve segment geometry before wiping children
	const preserved = isSegmentFill
		? {
				left: trackOrFill.style.left,
				width: trackOrFill.style.width,
				top: trackOrFill.style.top || "0",
				bottom: trackOrFill.style.bottom || "0",
				position: trackOrFill.style.position || "absolute",
			}
		: null;

	trackOrFill.innerHTML = "";
	trackOrFill.style.display = "flex";
	trackOrFill.style.boxSizing = "border-box";
	trackOrFill.style.overflow = "hidden";
	trackOrFill.style.justifyContent = "flex-start";
	trackOrFill.style.alignItems = "stretch";

	if (isSegmentFill && preserved) {
		// Keep left/width as % of sequence spine — never stretch to host width
		trackOrFill.style.position = preserved.position;
		trackOrFill.style.top = preserved.top;
		trackOrFill.style.bottom = preserved.bottom;
		trackOrFill.style.left = preserved.left;
		trackOrFill.style.width = preserved.width;
		trackOrFill.style.maxWidth = preserved.width;
		trackOrFill.style.right = "auto";
	} else {
		// Solo full-row strip
		trackOrFill.style.width = "100%";
	}

	const n = thumbnailPaths.length;
	const tileWidthPct = 100 / n;
	for (const pathString of thumbnailPaths) {
		const imgElement = document.createElement("img");
		imgElement.src = window.__TAURI__.core.convertFileSrc(pathString);
		imgElement.className =
			"h-full object-cover border-r border-zinc-200 dark:border-zinc-700 pointer-events-none";
		imgElement.style.flex = "1 1 0";
		imgElement.style.minWidth = "0";
		imgElement.style.width = `${tileWidthPct}%`;
		imgElement.style.boxSizing = "border-box";
		imgElement.style.height = "100%";
		trackOrFill.appendChild(imgElement);
	}
};

/**
 * Layout a join-row track on the sequence spine.
 *
 * Sequence playhead alignment (unchanged):
 *   activeLeft%  = offset / total
 *   activeWidth% = duration / total   (duration = clipOut − clipIn)
 *
 * Full-source visualization (solo-like tint outside clipIn/Out):
 *   Map this clip's full mediaDuration onto the row so that the active
 *   [clipIn, clipOut] band lines up exactly with the sequence slot above.
 *   Head (0..clipIn) and tail (clipOut..mediaDuration) are tinted — user can
 *   see the source is longer than the joined segment.
 *
 * Returns the content host for filmstrip / waveform painting.
 */
const applySegmentWindow = (trackEl, seg, totalDuration) => {
	if (!trackEl || !seg || totalDuration <= 0) return trackEl;
	const total = Math.max(totalDuration, 0.001);
	const activeDur = Math.max(Number(seg.duration) || 0, 0.001);
	const clipIn = Math.max(0, Number(seg.clipIn) || 0);
	let clipOut = Number(seg.clipOut) || clipIn + activeDur;
	let mediaDur =
		typeof getMediaDurationForQueueIndex === "function"
			? getMediaDurationForQueueIndex(seg.video, seg.queueIndex)
			: Number(seg.video?.mediaDuration) || 0;
	if (mediaDur <= 0) mediaDur = Math.max(clipOut, activeDur);
	if (clipOut > mediaDur) clipOut = mediaDur;
	if (clipOut <= clipIn) clipOut = Math.min(mediaDur, clipIn + activeDur);

	// Active window on the sequence spine (flush join boundary)
	const activeLeftPct = (seg.offset / total) * 100;
	const activeWidthPct = (activeDur / total) * 100;

	// Full media shell: scale so [clipIn, clipOut] maps onto the active slot
	const fullWidthPct = activeWidthPct * (mediaDur / activeDur);
	const fullLeftPct = activeLeftPct - (clipIn / mediaDur) * fullWidthPct;
	const headFrac = mediaDur > 0 ? clipIn / mediaDur : 0;
	const tailFrac =
		mediaDur > 0 ? Math.max(0, (mediaDur - clipOut) / mediaDur) : 0;

	// Outer track = full-width sequence spine (click target for seek)
	trackEl.style.position = "relative";
	trackEl.style.width = "100%";
	trackEl.style.display = "block";
	trackEl.style.overflow = "hidden";
	trackEl.innerHTML = "";
	trackEl.dataset.sequenceSpine = "1";
	trackEl.dataset.segOffset = String(seg.offset);
	trackEl.dataset.segDuration = String(seg.duration);
	trackEl.dataset.leftPct = String(activeLeftPct);
	trackEl.dataset.widthPct = String(activeWidthPct);

	// Soft dim for sequence time not owned by this clip (other join slots)
	if (activeLeftPct > 0.001) {
		const leftDim = document.createElement("div");
		leftDim.className = "sequence-row-dim sequence-row-dim-before";
		leftDim.style.cssText = `position:absolute;top:0;bottom:0;left:0;width:${activeLeftPct}%;pointer-events:none;z-index:0;`;
		trackEl.appendChild(leftDim);
	}
	const afterActive = Math.max(0, 100 - activeLeftPct - activeWidthPct);
	if (afterActive > 0.001) {
		const rightDim = document.createElement("div");
		rightDim.className = "sequence-row-dim sequence-row-dim-after";
		rightDim.style.cssText = `position:absolute;top:0;bottom:0;left:${activeLeftPct + activeWidthPct}%;width:${afterActive}%;pointer-events:none;z-index:0;`;
		trackEl.appendChild(rightDim);
	}

	// Full-source shell (may extend into dimmed neighbor sequence space on this row)
	const shell = document.createElement("div");
	shell.className = "sequence-segment-fill sequence-media-shell";
	shell.dataset.queueIndex = String(seg.queueIndex);
	shell.dataset.leftPct = String(fullLeftPct);
	shell.dataset.widthPct = String(fullWidthPct);
	shell.dataset.activeLeftPct = String(activeLeftPct);
	shell.dataset.activeWidthPct = String(activeWidthPct);
	shell.dataset.clipIn = String(clipIn);
	shell.dataset.clipOut = String(clipOut);
	shell.dataset.mediaDuration = String(mediaDur);
	shell.style.position = "absolute";
	shell.style.top = "0";
	shell.style.bottom = "0";
	shell.style.left = `${fullLeftPct}%`;
	shell.style.width = `${fullWidthPct}%`;
	shell.style.maxWidth = "none";
	shell.style.right = "auto";
	shell.style.zIndex = "2";
	shell.style.display = "block";
	shell.style.overflow = "hidden";
	shell.style.boxSizing = "border-box";

	// Content host (filmstrip / waveform) fills the full source shell
	const content = document.createElement("div");
	content.className = "sequence-media-content";
	content.dataset.queueIndex = String(seg.queueIndex);
	content.style.cssText =
		"position:absolute;inset:0;display:flex;align-items:stretch;overflow:hidden;box-sizing:border-box;z-index:1;";
	shell.appendChild(content);

	// Solo-matching tint: outside clipIn / clipOut on this source
	if (headFrac > 0.001) {
		const headShade = document.createElement("div");
		headShade.className = "sequence-clip-shade sequence-clip-shade-before";
		headShade.title = "Before Clip In (source not used in sequence)";
		headShade.style.cssText = `position:absolute;top:0;bottom:0;left:0;width:${headFrac * 100}%;z-index:3;pointer-events:none;`;
		shell.appendChild(headShade);
	}
	if (tailFrac > 0.001) {
		const tailShade = document.createElement("div");
		tailShade.className = "sequence-clip-shade sequence-clip-shade-after";
		tailShade.title = "After Clip Out (source not used in sequence)";
		tailShade.style.cssText = `position:absolute;top:0;bottom:0;left:${(1 - tailFrac) * 100}%;width:${tailFrac * 100}%;z-index:3;pointer-events:none;`;
		shell.appendChild(tailShade);
	}

	// Active-window outline (flush join edge) for clarity
	const activeBand = document.createElement("div");
	activeBand.className = "sequence-active-band";
	activeBand.style.cssText = `position:absolute;top:0;bottom:0;left:${headFrac * 100}%;width:${Math.max(0, (1 - headFrac - tailFrac) * 100)}%;z-index:2;pointer-events:none;box-sizing:border-box;`;
	shell.appendChild(activeBand);

	// Clip-edge fade zones: filmstrip (video track) only — not audio/waveform
	const isVideoTrack =
		trackEl.classList.contains("sequence-video-track") ||
		trackEl.id === "timeline-video-track";
	if (isVideoTrack && typeof window.paintClipFadeZonesOnHost === "function") {
		const fades =
			typeof getVideoFadeSeconds === "function"
				? getVideoFadeSeconds(seg.video, seg.queueIndex)
				: {
						fadeInSec: Number(seg.video?.fadeInSec) || 0,
						fadeOutSec: Number(seg.video?.fadeOutSec) || 0,
					};
		window.paintClipFadeZonesOnHost(shell, {
			clipIn,
			clipOut,
			fadeInSec: fades.fadeInSec,
			fadeOutSec: fades.fadeOutSec,
			mediaRelative: true,
			mediaDur,
		});
	}

	trackEl.appendChild(shell);
	return content;
};

/** Generates and loads the waveform timeline and thumbnails (solo or active join run). */
window.loadWaveformTimeline = async () => {
	const isTauri = window.__TAURI__ !== undefined;
	if (!isTauri || !videoFilePath) return;

	// Capture request identity so stale async jobs (switch A→B mid-flight) never mutate UI
	const requestPath = videoFilePath;
	const requestActiveIndex = activeQueueIndex;
	window._timelineGenId = (window._timelineGenId || 0) + 1;
	const genId = window._timelineGenId;
	const isStaleRequest = () =>
		genId !== window._timelineGenId ||
		videoFilePath !== requestPath ||
		activeQueueIndex !== requestActiveIndex;

	const seekBarContainer = document.getElementById("seekBarContainer");

	if (document.body.classList.contains("miniplayer-mode")) {
		// Miniplayer: keep seek bar only; detailed panel is CSS-hidden by mode
		if (seekBarContainer) seekBarContainer.style.display = "block";
		return;
	}

	if (seekBarContainer) {
		seekBarContainer.style.display = "block";
	}
	// Visibility of #detailed-timeline-panel is driven by .timeline-expanded CSS

	// Ensure zoom controls bound; recompute fit width (keep user zoom factor if set)
	if (typeof window.initTimelineZoomControls === "function") {
		window.initTimelineZoomControls();
	}
	if (typeof window.applyTimelineZoomLayout === "function") {
		const forceFit = !window._timelineZoom?.userOverride;
		window.applyTimelineZoomLayout({ forceFit });
	}

	const run = getActiveJoinRun();
	const mode = syncSequenceModeState(run);
	const multi = mode.active && run.segments.length > 1;
	const rows = ensureSequenceTrackRows(Math.max(1, run.segments.length || 1));

	try {
		if (!multi) {
			// -------- Solo path (unchanged behaviour) --------
			const videoEl = document.querySelector("video") || player;
			const duration = videoEl.duration || player.duration || 0;
			// Zoom content width drives tile density (fit * factor)
			if (typeof window.applyTimelineZoomLayout === "function") {
				window.applyTimelineZoomLayout();
			}
			const peakArray = await window.__TAURI__.core.invoke(
				"get_waveform_data",
				{
					videoPath: requestPath,
					durationSeconds: duration,
				},
			);
			if (isStaleRequest()) return;

			if (!peakArray || peakArray.length === 0) {
				console.warn("Waveform data empty, bypassing timeline initialization.");
				window.currentWaveformData = [];
				return;
			}

			window.currentWaveformData = peakArray;
			window.currentWaveformDataPath = requestPath;

			window.paintTimelineRuler(duration);
			window.setupVideoTrack();
			window.renderAudioWaveformCanvas();
			if (typeof window.paintTimelineMarkersAndShading === "function") {
				window.paintTimelineMarkersAndShading();
			}

			const videoTrack =
				rows[0]?.videoTrack || document.getElementById("timeline-video-track");

			if (isAudioOnlyMedia(requestPath)) {
				if (videoTrack) {
					videoTrack.textContent = "Audio File Track";
					videoTrack.style.display = "flex";
					videoTrack.style.alignItems = "center";
					videoTrack.style.justifyContent = "center";
					videoTrack.style.width = "100%";
					window.setupVideoTrack();
				}
				return;
			}

			if (videoTrack) {
				videoTrack.textContent = "Developing Video Filmstrip Tracks...";
				videoTrack.style.width = "100%";
				videoTrack.style.display = "flex";
				videoTrack.style.boxSizing = "border-box";
				window.setupVideoTrack();
			}

			const trackWidth =
				(typeof window.getTimelineContentWidth === "function"
					? window.getTimelineContentWidth()
					: 0) ||
				videoTrack?.offsetWidth ||
				0;
			const requiredTileCount = Math.max(Math.floor(trackWidth / 120), 1);

			// Solo: still bound to active clipIn/Out so full-file strip is not used
			// when the user has trimmed the slot.
			const soloIn = clipInTime || 0;
			const soloOut =
				clipOutTime > 0
					? clipOutTime
					: (document.querySelector("video") || player)?.duration || 0;

			window.__TAURI__.core
				.invoke("generate_timeline_thumbnails", {
					videoPath: requestPath,
					tileCount: requiredTileCount,
					startSeconds: soloIn,
					endSeconds: soloOut > soloIn ? soloOut : undefined,
				})
				.then((thumbnailPaths) => {
					if (isStaleRequest()) return;
					if (!videoTrack || !thumbnailPaths || thumbnailPaths.length === 0) {
						return;
					}
					fillFilmstripTrack(videoTrack, thumbnailPaths);
					window.setupVideoTrack();
					if (typeof window.refreshClipFadeTimelineZones === "function") {
						window.refreshClipFadeTimelineZones();
					}
				})
				.catch((err) => {
					if (isStaleRequest()) return;
					console.error("Error generating filmstrip thumbnails:", err);
					if (videoTrack) {
						videoTrack.textContent = "Failed to load filmstrip.";
						window.setupVideoTrack();
					}
				});
			return;
		}

		// -------- Multi-segment active join run --------
		const totalDuration = Math.max(run.totalDuration, 0.001);
		window.currentWaveformData = [];
		window.currentWaveformDataPath = null;

		if (typeof window.applyTimelineZoomLayout === "function") {
			window.applyTimelineZoomLayout();
		}
		window.paintTimelineRuler(totalDuration);

		// Wire seek listeners + playheads on each track (sequence mode)
		if (typeof window.setupSequenceTracks === "function") {
			window.setupSequenceTracks(totalDuration);
		}

		// Use zoomed content width so tile density scales with zoom, not only viewport
		const hostWidth =
			(typeof window.getTimelineContentWidth === "function"
				? window.getTimelineContentWidth()
				: 0) ||
			document.getElementById("timeline-zoom-content")?.offsetWidth ||
			document.getElementById("timeline-tracks-host")?.offsetWidth ||
			600;

		// Generate per-segment filmstrip + waveform concurrently
		await Promise.all(
			run.segments.map(async (seg, i) => {
				const row = rows[i];
				if (!row) return;
				const path = seg.video?.videoFilePath || "";
				const labelEl = row.pair.querySelector(".sequence-segment-label");
				if (labelEl) {
					const name =
						seg.video?.videoFileName ||
						seg.video?.videoName ||
						`Clip ${seg.queueIndex + 1}`;
					labelEl.textContent = `${seg.queueIndex + 1}. ${name}`;
				}

				const videoFill = applySegmentWindow(
					row.videoTrack,
					seg,
					totalDuration,
				);
				const audioFill = applySegmentWindow(
					row.audioTrack,
					seg,
					totalDuration,
				);

				if (!path) {
					if (videoFill) videoFill.textContent = "No media";
					return;
				}

				// Full source media duration (tint shows outside clipIn/Out)
				const mediaDur = Math.max(
					getMediaDurationForQueueIndex(seg.video, seg.queueIndex) || 0,
					Number(seg.clipOut) || 0,
					Number(seg.duration) || 0,
					0.05,
				);
				const clipInSec = Math.max(0, Number(seg.clipIn) || 0);
				const clipOutSec =
					Number(seg.clipOut) > clipInSec ? Number(seg.clipOut) : mediaDur;

				// Waveform for full source so head/tail outside clip bounds are visible under tint
				try {
					const peaks = await window.__TAURI__.core.invoke(
						"get_waveform_data",
						{
							videoPath: path,
							durationSeconds: mediaDur,
						},
					);
					if (isStaleRequest()) return;
					if (typeof window.renderWaveformInto === "function") {
						window.renderWaveformInto(audioFill || row.audioTrack, peaks);
					}
					if (seg.queueIndex === activeQueueIndex) {
						window.currentWaveformData = peaks || [];
						window.currentWaveformDataPath = path;
					}
				} catch (err) {
					if (isStaleRequest()) return;
					console.warn("Segment waveform failed:", path, err);
				}

				if (isAudioOnlyMedia(path)) {
					if (videoFill) {
						videoFill.textContent = "Audio File Track";
						videoFill.style.alignItems = "center";
						videoFill.style.justifyContent = "center";
						videoFill.style.display = "flex";
					}
					return;
				}

				if (videoFill) {
					videoFill.textContent = "…";
					videoFill.style.display = "flex";
					videoFill.style.alignItems = "center";
					videoFill.style.justifyContent = "center";
				}

				// Tile density from full-source shell width on the sequence spine
				const activeWidthPx = Math.max(
					40,
					(seg.duration / totalDuration) * hostWidth,
				);
				const fullWidthPx = Math.max(
					activeWidthPx,
					activeWidthPx * (mediaDur / Math.max(seg.duration, 0.001)),
				);
				const tileCount = Math.max(Math.floor(fullWidthPx / 120), 1);

				try {
					// Full source filmstrip; CSS shades tint outside [clipIn, clipOut]
					const thumbnailPaths = await window.__TAURI__.core.invoke(
						"generate_timeline_thumbnails",
						{
							videoPath: path,
							tileCount: tileCount,
							startSeconds: 0,
							endSeconds: mediaDur,
						},
					);
					if (isStaleRequest()) return;
					if (videoFill && thumbnailPaths?.length) {
						fillFilmstripTrack(videoFill, thumbnailPaths);
					} else if (videoFill) {
						videoFill.textContent = "No filmstrip";
					}
				} catch (err) {
					if (isStaleRequest()) return;
					console.error("Segment filmstrip failed:", path, err);
					if (videoFill) videoFill.textContent = "Failed to load filmstrip.";
				}
			}),
		);

		if (isStaleRequest()) return;

		// Playheads + markers on sequence spine
		if (typeof window.setupSequenceTracks === "function") {
			window.setupSequenceTracks(totalDuration);
		}
		if (typeof window.paintTimelineMarkersAndShading === "function") {
			window.paintTimelineMarkersAndShading();
		}
		// Re-paint fade zones after filmstrip fills (zones are on shells, not content)
		if (typeof window.refreshClipFadeTimelineZones === "function") {
			window.refreshClipFadeTimelineZones();
		}
	} catch (err) {
		if (isStaleRequest()) return;
		console.error("Error generating waveform data:", err);
		window.currentWaveformData = [];
	}
};

/** Joins and compresses the selected video segments. */
window.joinAndCompressVideos = async (videoSegments) => {
	const proceed = await asyncConfirm(
		"Joining these videos will clear all active timeline markers upon success. Do you want to proceed?",
		"Confirm Join & Compress",
	);
	if (!proceed) return;

	const isTauri = window.__TAURI__ !== undefined;
	if (!isTauri) {
		alert("Tauri desktop API is required.");
		return;
	}

	if (!videoSegments || videoSegments.length < 1) {
		alert("Please select at least one video to join.");
		return;
	}

	const outputFileName = await asyncPrompt(
		"Enter output file name (e.g. final_video.mp4):",
		"final_video.mp4",
		"Output File",
	);
	if (!outputFileName) return;

	const joinBtn = document.getElementById("joinAndCompressBtn");
	const originalText = joinBtn
		? joinBtn.textContent
		: "Join & Compress Selected";
	if (joinBtn) {
		joinBtn.disabled = true;
		joinBtn.textContent = "Processing...";
	}

	showToast("Joining and compressing videos... This may take a while.", "info");

	try {
		const finalPath = await window.__TAURI__.core.invoke(
			"join_and_compress_videos",
			{
				// One field per VideoSegment key — never both loop_count and loopCount
				videoSegments: videoSegments.map((s) => ({
					path: s.path,
					start_time: Number(s.start_time) || 0,
					end_time: Number(s.end_time) || 0,
					loop_count: Math.max(1, Number(s.loopCount ?? s.loop_count) || 1),
				})),
				outputFileName: outputFileName,
			},
		);

		// On Success (State Reset)
		markers = [];
		if (DOM.markerTicksContainer) DOM.markerTicksContainer.innerHTML = "";

		if (typeof updateMarkersList === "function") updateMarkersList();
		if (typeof updateSliderTicks === "function") updateSliderTicks();
		saveLocalState();

		showToast(
			"Success! Final video generated. Active markers have been reset.",
			"success",
		);
	} catch (err) {
		toConsole("Join & Compress failed", err, debuggin);
		alert(`Join and Compress failed: ${err.message || err}`);
	} finally {
		if (joinBtn) {
			joinBtn.disabled = false;
			joinBtn.textContent = originalText;
		}
	}
};

/** Processes and loads a new video file into the active project slot. */
const processNewVideoFile = async (fileOrPath, isTauriPath = false) => {
	if (isQueueIndexJoined(activeQueueIndex)) {
		showToast(
			"Unjoin first before replacing media on this queue item.",
			"error",
		);
		return;
	}

	resetVideoViewport(player);
	const currentSrc = player.getAttribute("src");
	const hasExistingVideo = currentSrc && currentSrc !== "";

	if (hasExistingVideo && markers.length > 0) {
		const save = await asyncConfirm(
			"You have unsaved data. Would you like to save your project before loading a new video?",
			"Unsaved Data",
		);
		if (save) {
			await exportToJSON(false);
			toConsole("Project saved before loading new video", null, debuggin);
		}
		const proceed = await asyncConfirm(
			"Loading a new video will clear all existing data. Are you sure you want to proceed?",
			"Load New Video",
		);
		if (!proceed) {
			toConsole("User cancelled loading new video", null, debuggin);
			return;
		}
	}

	const isRelinking =
		!hasExistingVideo && (markers.length > 0 || projectName !== "");

	// Media replace: drop captions; purge proxy for the path we are leaving
	const previousItem = videoQueue[activeQueueIndex]
		? { ...videoQueue[activeQueueIndex] }
		: null;
	if (typeof window.clearSubtitleTracks === "function") {
		window.clearSubtitleTracks();
	}

	if (isTauriPath) {
		// Tauri dialog path: route through loadVideo (verify_and_prepare_video proxy)
		const filePath =
			typeof fileOrPath === "object" ? fileOrPath.path : fileOrPath;
		if (
			previousItem?.videoFilePath &&
			previousItem.videoFilePath !== filePath &&
			typeof window.deleteProxyForQueueItem === "function"
		) {
			await window.deleteProxyForQueueItem(previousItem);
		}
		videoFileName =
			typeof fileOrPath === "object" && fileOrPath.name
				? fileOrPath.name
				: filePath.split(/[/\\]/).pop();
		videoFilePath = filePath;
		saveLocalState();
		await window.loadVideo(filePath);
	} else {
		const file = fileOrPath;
		const nextPath = file.path || "";
		if (
			previousItem?.videoFilePath &&
			nextPath &&
			previousItem.videoFilePath !== nextPath &&
			typeof window.deleteProxyForQueueItem === "function"
		) {
			await window.deleteProxyForQueueItem(previousItem);
		}
		videoFileName = file.name;
		videoFilePath = nextPath; // Tauri may inject absolute path on drop/input
		saveLocalState();

		const isTauri = window.__TAURI__ !== undefined;
		if (isTauri && videoFilePath) {
			// Disk path available: proxy path for H.265
			await window.loadVideo(videoFilePath);
		} else {
			// Browser-only blob path — intentional exception (no filesystem path)
			const fileURL = URL.createObjectURL(file);
			videoBlobCache[videoFileName] = fileURL;
			player.src = fileURL;
			player.preload = "metadata";
			player.load();
			if (typeof window.clearSubtitleTracks === "function") {
				window.clearSubtitleTracks();
			}
			toggleVideoPlaceholder(false);
			updateLoadButtonColor();
			if (typeof window.updateProxyInfoUi === "function") {
				window.updateProxyInfoUi(null);
			}
		}
	}

	if (!isRelinking) {
		markers = [];
		projectName = "";
		if (DOM.projectNameInput) {
			DOM.projectNameInput.value = "";
		}
		updateMarkersList();
		toConsole("Cleared all previous data", null, debuggin);
	} else {
		toConsole("Re-linked video to existing project", videoFileName, debuggin);
	}

	DOM.videoPlaceholder.textContent = "Load a video to get started";
	saveLocalState();
	renderVideoQueueSelect();
	if (typeof window.refreshSidebarPlaylist === "function") {
		window.refreshSidebarPlaylist();
	}
	updateSliderTicks();
};

/**
 * Calculates the visible rectangle of the video taking into account
 * zoom, pan, and container aspect ratio.
 */
const calculateVisibleVideoRect = (video, container) => {
	const containerWidth = container.offsetWidth;
	const containerHeight = container.offsetHeight;

	const videoRatio = video.videoWidth / video.videoHeight;
	const containerRatio = containerWidth / containerHeight;

	let baseWidth;
	let baseHeight;

	if (videoRatio > containerRatio) {
		baseWidth = containerWidth;
		baseHeight = containerWidth / videoRatio;
	} else {
		baseHeight = containerHeight;
		baseWidth = containerHeight * videoRatio;
	}

	const baseLeft = (containerWidth - baseWidth) / 2;
	const baseTop = (containerHeight - baseHeight) / 2;

	const currentZoom = window.zoomLevel || 1.0;
	const currentX = window.translateX || 0;
	const currentY = window.translateY || 0;

	const layoutX1 = -currentX / currentZoom;
	const layoutY1 = -currentY / currentZoom;
	const layoutX2 = (containerWidth - currentX) / currentZoom;
	const layoutY2 = (containerHeight - currentY) / currentZoom;

	const videoX1 = layoutX1 - baseLeft;
	const videoY1 = layoutY1 - baseTop;
	const videoX2 = layoutX2 - baseLeft;
	const videoY2 = layoutY2 - baseTop;

	let sx = videoX1 * (video.videoWidth / baseWidth);
	let sy = videoY1 * (video.videoHeight / baseHeight);
	let sw = (videoX2 - videoX1) * (video.videoWidth / baseWidth);
	let sh = (videoY2 - videoY1) * (video.videoHeight / baseHeight);

	sx = Math.max(0, sx);
	sy = Math.max(0, sy);
	if (sw > video.videoWidth - sx) {
		sw = video.videoWidth - sx;
	}
	if (sh > video.videoHeight - sy) {
		sh = video.videoHeight - sy;
	}

	return { sx, sy, sw, sh };
};

/**
 * Captures the specified rect of the video onto a canvas and downloads it.
 */
const downloadCanvasImage = (video, rect) => {
	const { sx, sy, sw, sh } = rect;
	const canvas = document.createElement("canvas");
	canvas.width = sw;
	canvas.height = sh;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;

	ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

	try {
		const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
		const link = document.createElement("a");
		const currentTimeStr = player.currentTime.toFixed(2).replace(".", "_");
		link.download = `snapshot_${currentTimeStr}.jpg`;
		link.href = dataUrl;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		showToast("Snapshot saved in Downloads", "success");
		window.triggerPlaybackOverlay("Snapshot Captured");
	} catch (error) {
		toConsole("Failed to take snapshot", error, debuggin);
		showToast("Error taking snapshot.", "error");
	}
};

/** Captures a snapshot of the current video frame. */
const takeSnapshot = () => {
	if (!player?.src) {
		showToast("No video loaded.", "error");
		return;
	}
	const video = player;
	const container = document.getElementById("video-wrapper-id");
	if (!container) {
		showToast("Error taking snapshot.", "error");
		return;
	}

	const rect = calculateVisibleVideoRect(video, container);
	downloadCanvasImage(video, rect);
};

/** Cycles layout mode: normal ↔ cinema ↔ miniplayer (or explicit target). */
// window.currentViewMode is initialized once at module top
window._viewModeTransitioning = false;

window.cycleViewMode = async (targetMode) => {
	// Serialize: ignore re-entry while native window ops / CSS settle
	if (window._viewModeTransitioning) {
		console.log(
			"[View System] Transition already in progress; ignoring concurrent cycleViewMode.",
		);
		return;
	}
	window._viewModeTransitioning = true;

	const mainGrid = document.getElementById("mainLayoutGrid");
	const modeBtn = document.getElementById("expand-player-btn");

	if (!mainGrid) {
		window._viewModeTransitioning = false;
		return;
	}

	try {
		// 1. Decide target mode
		if (
			targetMode &&
			["normal", "cinema", "miniplayer"].includes(targetMode.toLowerCase())
		) {
			window.currentViewMode = targetMode.toLowerCase();
		} else {
			// Progressive carousel: normal → cinema → miniplayer → normal
			switch (window.currentViewMode) {
				case "normal":
					window.currentViewMode = "cinema";
					break;
				case "cinema":
					window.currentViewMode = "miniplayer";
					break;
				default:
					window.currentViewMode = "normal";
					break;
			}
		}

		const mode = window.currentViewMode;
		localStorage.setItem("currentViewMode", mode);
		console.log(
			`[View System] Shifting layout mode configuration to: ${mode.toUpperCase()}`,
		);

		// 2. Reset marquee zoom/translation transforms on view mode transitions
		const videoElement = document.querySelector("video");
		const videoViewport = document.getElementById("video-viewport");
		const videoWrapper = document.getElementById("video-wrapper-id");

		for (const el of [videoElement, videoViewport, videoWrapper]) {
			if (el) {
				el.style.transform = "none";
				el.style.left = "0";
				el.style.top = "0";
			}
		}

		if (videoWrapper) {
			videoWrapper.style.width = "";
			videoWrapper.style.height = "";
		}

		// 3. Native Tauri window ops (canonical per mode)
		if (window.__TAURI__?.window?.getCurrentWindow) {
			const appWindow = window.__TAURI__.window.getCurrentWindow();

			if (mode === "normal") {
				// fullscreen false, alwaysOnTop false, resizable true, maximize
				await appWindow.setFullscreen(false);
				await appWindow.setAlwaysOnTop(false);
				await appWindow.setResizable(true);
				await appWindow.maximize();
			} else if (mode === "cinema") {
				// alwaysOnTop false, fullscreen true
				await appWindow.setAlwaysOnTop(false);
				await appWindow.setFullscreen(true);
			} else if (mode === "miniplayer") {
				// fullscreen false, unmaximize, setSize(~580x524), alwaysOnTop true
				await appWindow.setFullscreen(false);
				await appWindow.unmaximize();
				await appWindow.setResizable(true);

				const targetWidth = 580;
				const targetHeight = 440 + 44 + 40; // 524px logical height

				const logicalSizeClass =
					window.__TAURI__?.window?.LogicalSize ||
					window.__TAURI__?.dpi?.LogicalSize;
				if (logicalSizeClass) {
					await appWindow.setSize(
						new logicalSizeClass(targetWidth, targetHeight),
					);
				} else {
					const factor = (await appWindow.scaleFactor()) || 1.0;
					await appWindow.setSize({
						type: "Physical",
						width: Math.round(targetWidth * factor),
						height: Math.round(targetHeight * factor),
					});
				}

				await appWindow.setAlwaysOnTop(true);
			}
		}

		// 4. Apply CSS classes immediately after window ops (no arbitrary 60ms delay)
		mainGrid.classList.remove(
			"normal-mode",
			"cinema-mode",
			"miniplayer-mode",
			"hide-controls",
		);
		document.body.classList.remove(
			"normal-mode",
			"cinema-mode",
			"miniplayer-mode",
		);
		mainGrid.classList.add(`${mode}-mode`);
		document.body.classList.add(`${mode}-mode`);

		if (modeBtn) {
			if (mode === "normal") modeBtn.title = "Switch to Cinema Mode";
			else if (mode === "cinema") modeBtn.title = "Switch to Miniplayer View";
			else modeBtn.title = "Switch to Normal View";
		}

		// One frame for layout paint, then light control/timeline re-sync
		await new Promise((resolve) => requestAnimationFrame(resolve));
		if (typeof window.repositionControls === "function") {
			window.repositionControls();
		}
		if (typeof window.setupVideoTrack === "function") {
			window.setupVideoTrack();
		}

		const vizCanvas = document.getElementById("vizCanvas");
		updateVisualizerControlsVisibility();
		if (vizCanvas) {
			resizeVisualizer(vizCanvas);
			if (
				mode === "normal" &&
				!isAudioOnlyMedia(videoFilePath || videoFileName)
			) {
				stopVisualizer(vizCanvas);
			} else if (mode === "miniplayer" || mode === "cinema") {
				if (isAudioOnlyMedia(videoFilePath || videoFileName)) {
					startVisualizer(vizCanvas, player);
				}
			}
		}

		requestAnimationFrame(() => {
			if (vizCanvas) resizeVisualizer(vizCanvas);
			setTimeout(() => {
				if (vizCanvas) resizeVisualizer(vizCanvas);
			}, 100);
		});

		// Rehydrate video session if entering Normal mode and no video currently loaded
		if (
			mode === "normal" &&
			(!player?.src ||
				player.src === "" ||
				player.src === window.location.href) &&
			typeof videoFilePath !== "undefined" &&
			videoFilePath &&
			typeof window.loadVideo === "function"
		) {
			window.loadVideo(videoFilePath).catch((err) => {
				console.error(
					"[View System] Error rehydrating video on switching to normal mode:",
					err,
				);
			});
		}
	} catch (err) {
		console.error("[View System] View mode transition failed:", err);
	} finally {
		window._viewModeTransitioning = false;
	}
};

// Centralized overlay presentation management engine
window.triggerPlaybackOverlay = (messageText) => {
	const overlayContainer =
		document.getElementById("video-action-overlay") ||
		document.querySelector(".action-overlay-toast");
	if (!overlayContainer) return;

	// Set the text content dynamically
	overlayContainer.innerText = messageText;

	// Make it instantly visible by removing any hidden or opacity-0 classes
	overlayContainer.classList.remove(
		"hidden",
		"opacity-0",
		"pointer-events-none",
	);
	overlayContainer.classList.add("flex", "opacity-100");

	// Clear any pre-existing fading timer to prevent race conditions during rapid tapping
	if (window.overlayFadeTimeout) {
		clearTimeout(window.overlayFadeTimeout);
	}

	// Schedule automatic self-destruct concealment after exactly 5000ms (5 seconds)
	window.overlayFadeTimeout = setTimeout(() => {
		console.log(
			"[Overlay System] Automatically fading transient action message indicator...",
		);
		overlayContainer.classList.add("opacity-0", "pointer-events-none");

		// Cleanly switch back to display none once the CSS opacity transition finishes painting
		setTimeout(() => {
			overlayContainer.classList.remove("flex");
			overlayContainer.classList.add("hidden");
		}, 300); // Matches standard tailwind/CSS transition-opacity duration metrics
	}, 5000);
};

/** Resets the inactivity timer for hiding controls in cinema mode. */
function resetCinemaIdleTimer() {
	// Gracefully drop out if we aren't currently viewing a movie clip layout
	if (window.currentViewMode !== "cinema") return;

	// Clear existing timeout using the bulletproof window wrapper
	if (window.cinemaIdleTimer) {
		clearTimeout(window.cinemaIdleTimer);
	}

	// Reveal the layout controls panel smoothly
	const mainGrid = document.getElementById("mainLayoutGrid");
	if (mainGrid) mainGrid.classList.remove("hide-controls");

	// Re-schedule the next 5-second hiding loop sequence safely
	window.cinemaIdleTimer = setTimeout(() => {
		if (window.currentViewMode === "cinema" && mainGrid) {
			mainGrid.classList.add("hide-controls");
		}
	}, 5000);
}

/** Initializes the primary video player events, controls, and UI state. */
const initializePlayer = () => {
	player = DOM.video;
	// Expose for classic scripts (timeline-engine, ui-components) outside module scope
	window.player = player;
	player.preservesPitch = true;
	playerReady = true;
	window.playerReady = true;
	toConsole("Video element initialized", "Success", debuggin);
	toConsole("App Version", APP_VERSION, debuggin);

	marqueeOverlay = DOM.marqueeOverlay;
	marqueeRect = DOM.marqueeRect;

	const isDarkMode = localStorage.getItem("darkMode") === "true";

	if (isDarkMode) {
		document.documentElement.classList.add("dark");
		DOM.sunIcon.classList.add("hidden");
		DOM.moonIcon.classList.remove("hidden");
	} else {
		document.documentElement.classList.remove("dark");
		DOM.sunIcon.classList.remove("hidden");
		DOM.moonIcon.classList.add("hidden");
	}

	DOM.darkModeToggle.addEventListener("click", () => {
		document.documentElement.classList.toggle("dark");
		const isDark = document.documentElement.classList.contains("dark");
		DOM.sunIcon.classList.toggle("hidden", isDark);
		DOM.moonIcon.classList.toggle("hidden", !isDark);
		localStorage.setItem("darkMode", isDark);
		toConsole("Dark mode toggled", isDark ? "On" : "Off", debuggin);

		updateMarkersList();
	});

	updateVisualizerControlsVisibility();

	const vizToggleBtn = document.getElementById("vizToggleBtn");

	vizToggleBtn?.addEventListener("click", () => {
		if (
			vizToggleBtn.disabled ||
			!isAudioOnlyMedia(videoFilePath || videoFileName)
		) {
			return;
		}
		const canvas = document.getElementById("vizCanvas");
		if (!canvas) return;
		if (isVisualizerActive()) {
			stopVisualizer(canvas);
			vizToggleBtn.classList.remove("btn-icon-highlight");
			vizToggleBtn.classList.add("btn-icon");
			showToast("Visualizer Off", "info");
		} else {
			startVisualizer(canvas, player);
			vizToggleBtn.classList.add("btn-icon-highlight");
			vizToggleBtn.classList.remove("btn-icon");
			showToast("Visualizer On", "success");
		}
	});

	player.addEventListener("play", () => {
		initVisualizerAudio(player);
		const canvas = document.getElementById("vizCanvas");
		if (
			canvas &&
			(isVisualizerActive() ||
				(window.currentViewMode !== "normal" &&
					isAudioOnlyMedia(videoFilePath || videoFileName)))
		) {
			startVisualizer(canvas, player);
		}
	});

	if (DOM.videoQueueSelect) {
		DOM.videoQueueSelect.addEventListener("change", (e) => {
			switchVideoInQueue(Number.parseInt(e.target.value, 10));
		});
	}
	if (DOM.addVideoQueueBtn) {
		DOM.addVideoQueueBtn.addEventListener("click", addNewVideoToQueue);
	}
	if (DOM.editVideoQueueBtn) {
		DOM.editVideoQueueBtn.addEventListener("click", editVideoInQueue);
	}
	document
		.getElementById("removeVideoQueueBtn")
		?.addEventListener("click", () => {
			if (typeof window.removeCurrentVideo === "function")
				window.removeCurrentVideo();
		});
	const reorderBtn = document.getElementById("reorder-videos-btn");
	if (reorderBtn) {
		reorderBtn.addEventListener("click", () => {
			const mainGrid = document.getElementById("mainLayoutGrid");
			if (mainGrid) {
				const isOpen = mainGrid.classList.toggle("playlist-sidebar-open");
				if (isOpen && typeof window.renderSidebarPlaylist === "function") {
					window.renderSidebarPlaylist();
				}
			}
		});
	}

	const closeSidebarBtn = document.getElementById("close-playlist-sidebar-btn");
	if (closeSidebarBtn) {
		closeSidebarBtn.addEventListener("click", () => {
			const mainGrid = document.getElementById("mainLayoutGrid");
			if (mainGrid) {
				mainGrid.classList.remove("playlist-sidebar-open");
			}
		});
	}

	const toggleMiniPlayerBtn = document.getElementById("toggleMiniPlayerBtn");
	if (toggleMiniPlayerBtn) {
		toggleMiniPlayerBtn.addEventListener("click", (e) => {
			e.preventDefault();
			window.cycleViewMode();
		});
	}

	const ccToggleBtn = document.getElementById("ccToggleBtn");
	if (ccToggleBtn) {
		ccToggleBtn.addEventListener("click", window.toggleClosedCaptions);
	}

	if (DOM.projectNameInput) {
		DOM.projectNameInput.addEventListener("blur", (e) => {
			e.target.value = sanitizeFilename(e.target.value);
			projectName = e.target.value;
			saveLocalState();
		});
		DOM.projectNameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.target.blur();
			}
		});
	}

	// Settings Panel Logic
	if (DOM.openSettingsBtn) {
		const saveSettingsData = () => {
			if (DOM.projectCommentsInput)
				projectComments = DOM.projectCommentsInput.value;
			saveLocalState();
			return true;
		};

		DOM.openSettingsBtn.addEventListener("click", () => toggleSettings(true));

		DOM.closeSettingsBtn.addEventListener("click", () => {
			saveSettingsData();
			toggleSettings(false);
		});

		DOM.settingsBackdrop.addEventListener("click", () => {
			saveSettingsData();
			toggleSettings(false);
		});
	}

	// Product chrome: open allow-listed https URLs once via shell (no target=_blank double-open)
	const productChrome = document.getElementById("productChrome");
	if (productChrome) {
		productChrome.addEventListener(
			"click",
			(e) => {
				const anchor = e.target.closest("a.product-chrome-link");
				if (!anchor) return;
				const url = anchor.getAttribute("href") || "";
				if (!url.startsWith("https://")) return;
				// Stop default navigation / WebView2 new-window before any async work
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();

				const openOnce = async () => {
					try {
						const shellOpen = window.__TAURI__?.shell?.open;
						if (typeof shellOpen === "function") {
							await shellOpen(url);
						} else if (window.__TAURI__?.core?.invoke) {
							await window.__TAURI__.core.invoke("plugin:shell|open", {
								path: url,
							});
						} else {
							window.open(url, "_blank", "noopener,noreferrer");
						}
					} catch (err) {
						console.warn("[ProductChrome] Failed to open URL:", url, err);
					}
				};
				void openOnce();
			},
			true,
		);
	}

	function configureTimelineTicks(duration) {
		if (duration > 0) {
			let tickSeconds = 60;
			if (duration <= 15)
				tickSeconds = 2; // e.g. 10s video = 5 ticks
			else if (duration <= 30)
				tickSeconds = 5; // e.g. 25s video = 5 ticks
			else if (duration <= 60)
				tickSeconds = 10; // e.g. 50s video = 5 ticks
			else if (duration <= 180)
				tickSeconds = 30; // e.g. 2m video = 4 ticks
			else if (duration <= 300)
				tickSeconds = 60; // e.g. 4m video = 4 ticks
			else if (duration <= 600)
				tickSeconds = 120; // e.g. 8m video = 4 ticks
			else if (duration <= 1800)
				tickSeconds = 300; // e.g. 25m video = 5 ticks
			else tickSeconds = 600; // 10m intervals for anything longer

			const tickInterval = (tickSeconds / duration) * 100;
			seekBar.style.setProperty("--tick-interval", `${tickInterval}%`);
		}
	}

	function bootTimelineVisualizers() {
		// Skip full strip rebuild after join handoff / soft sequence source switch
		if (window._skipNextTimelineBoot || window._sequenceHandoffInProgress) {
			window._skipNextTimelineBoot = false;
			return;
		}
		if (videoFilePath) {
			if (window.currentViewMode !== "miniplayer") {
				window.loadWaveformTimeline();
			}
		}
	}

	player.addEventListener("timeupdate", seektimeupdate);
	player.addEventListener("play", () => {
		if (typeof window.ensureClipFadePreviewLoop === "function") {
			window.ensureClipFadePreviewLoop();
		}
		if (typeof window.applyClipEdgeFadePreview === "function") {
			window.applyClipEdgeFadePreview();
		}
		if (typeof window.applyActiveSpeedPlayback === "function") {
			window.applyActiveSpeedPlayback();
		}
	});
	player.addEventListener("pause", () => {
		if (typeof window.ensureClipFadePreviewLoop === "function") {
			window.ensureClipFadePreviewLoop();
		}
		if (typeof window.applyClipEdgeFadePreview === "function") {
			window.applyClipEdgeFadePreview();
		}
		if (typeof window.applyActiveSpeedPlayback === "function") {
			window.applyActiveSpeedPlayback();
		}
	});
	player.addEventListener("seeked", () => {
		if (typeof window.applyClipEdgeFadePreview === "function") {
			window.applyClipEdgeFadePreview();
		}
		if (typeof window.applyActiveSpeedPlayback === "function") {
			window.applyActiveSpeedPlayback();
		}
	});
	player.addEventListener("loadedmetadata", () => {
		const duration = player.duration;
		configureTimelineTicks(duration);

		// Joined runs and explicit preserve: keep user clipIn/Out (do not force full file).
		// Solo first load: default 0..duration.
		const joined = isQueueIndexJoined(activeQueueIndex);
		if (preserveClipBounds || joined) {
			if (
				clipOutTime === undefined ||
				clipOutTime === null ||
				clipOutTime <= 0 ||
				(duration > 0 && clipOutTime > duration)
			) {
				clipOutTime = duration;
			}
			if (clipInTime < 0) clipInTime = 0;
			preserveClipBounds = false;
		} else {
			clipInTime = 0;
			clipOutTime = duration;
		}

		// Cache media duration + clip bounds for sequence spine math
		if (typeof videoQueue !== "undefined" && videoQueue[activeQueueIndex]) {
			videoQueue[activeQueueIndex].mediaDuration = duration || 0;
			videoQueue[activeQueueIndex].clipInTime = clipInTime;
			videoQueue[activeQueueIndex].clipOutTime = clipOutTime;
		}

		// Prefer marker-derived bounds when in/out markers exist
		if (typeof syncClipBoundsFromMarkers === "function") {
			syncClipBoundsFromMarkers(activeQueueIndex);
		}

		const multi = typeof isActiveRunMulti === "function" && isActiveRunMulti();
		const run =
			multi && typeof getActiveJoinRun === "function"
				? getActiveJoinRun()
				: null;
		if (typeof seekBar !== "undefined" && seekBar) {
			seekBar.max = multi
				? Math.max(run?.totalDuration || 0, 0.001)
				: duration || 0;
		}

		const displayDur = multi
			? Math.max(run?.totalDuration || 0, 0.001)
			: duration || 0;
		updateTimeDisplay(displayDur, "durationTime");
		positionControls();
		updateLoadButtonColor();
		toggleVideoPlaceholder(false);
		updateSliderTicks();
		// Render markers table shell (incl. #markersTableFoot) before filling the footer
		if (typeof updateMarkersList === "function") updateMarkersList();
		if (typeof updateVideoTimeSummary === "function") updateVideoTimeSummary();
		// Clip bounds may affect join segment offsets — rebuild multi layout
		if (multi && typeof scheduleJoinTimelineRebuild === "function") {
			scheduleJoinTimelineRebuild();
		}

		player.playbackRate = playbackSpeed;
		speedSlider.value = playbackSpeed;
		DOM.speedValue.textContent = `${playbackSpeed.toFixed(1)}x`;
		toConsole("Playback speed restored", playbackSpeed, debuggin);

		// Soft handoff / sequence continue: preserve volume+mute (do NOT force mute-on-load)
		const softAudio = window._softHandoffAudio;
		const isSoftHandoffLoad =
			!!window._softHandoffVolumeActive ||
			!!softAudio ||
			!!window._sequenceHandoffInProgress ||
			!!window._sequenceContinuePlay;
		if (isSoftHandoffLoad) {
			const vol = softAudio
				? Number.isFinite(softAudio.volume)
					? softAudio.volume
					: volumeLevel
				: volumeLevel;
			const muted = softAudio ? !!softAudio.muted : !!player.muted;
			if (typeof applyTransportVolume === "function") {
				applyTransportVolume(vol, muted);
			} else if (typeof window.applyTransportVolume === "function") {
				window.applyTransportVolume(vol, muted);
			} else {
				player.volume = clampVolume01(vol);
				player.muted = muted;
				volumeLevel = player.volume;
			}
			// Keep capture until handoff/seek finally clears the active flag
			toConsole(
				"Soft handoff volume preserved",
				{ volume: vol, muted },
				debuggin,
			);
		} else if (isAudioOnlyMedia(videoFilePath || videoFileName)) {
			// Prefer per-clip remembered volume when available
			const resolved =
				typeof resolveVolumeForQueueIndex === "function"
					? resolveVolumeForQueueIndex(activeQueueIndex)
					: { volume: volumeLevel, muted: false };
			if (typeof applyTransportVolume === "function") {
				applyTransportVolume(resolved.volume, false);
			} else {
				player.volume = clampVolume01(resolved.volume);
				player.muted = false;
				volumeLevel = player.volume;
				if (volumeSlider) volumeSlider.value = volumeLevel;
				if (DOM.volumeValue) {
					DOM.volumeValue.textContent = String(Math.round(volumeLevel * 100));
				}
				DOM.volumeOnIcon?.classList.remove("hidden");
				DOM.volumeOffIcon?.classList.add("hidden");
			}
			toConsole("Audio file unmuted on load", "Success", debuggin);
		} else {
			// Hard load: keep existing mute-on-load UX, but volume from per-clip memory
			const resolved =
				typeof resolveVolumeForQueueIndex === "function"
					? resolveVolumeForQueueIndex(activeQueueIndex)
					: { volume: volumeLevel, muted: true };
			if (typeof applyTransportVolume === "function") {
				applyTransportVolume(resolved.volume, true);
			} else {
				player.volume = clampVolume01(resolved.volume);
				player.muted = true;
				volumeLevel = player.volume;
				if (volumeSlider) volumeSlider.value = 0;
				if (DOM.volumeValue) DOM.volumeValue.textContent = "0";
				DOM.volumeOnIcon?.classList.add("hidden");
				DOM.volumeOffIcon?.classList.remove("hidden");
			}
			toConsole("Video muted on load", "Success", debuggin);
		}

		bootTimelineVisualizers();
		initializeVideoViewportZoomPan(
			player,
			document.getElementById("video-wrapper-id"),
		);
	});
	player.addEventListener("play", () => {
		DOM.playIcon.classList.add("hidden");
		DOM.pauseIcon.classList.remove("hidden");
		window.lastCheckedVideoTime = player.currentTime;
		if (!window.playheadAnimationId) {
			window.playheadAnimationId = requestAnimationFrame(
				window.syncTimelinePlayheadSmoothly,
			);
		}
	});
	player.addEventListener("playing", () => {
		window.lastCheckedVideoTime = player.currentTime;
		if (!window.playheadAnimationId) {
			window.playheadAnimationId = requestAnimationFrame(
				window.syncTimelinePlayheadSmoothly,
			);
		}
	});
	player.addEventListener("pause", () => {
		DOM.playIcon.classList.remove("hidden");
		DOM.pauseIcon.classList.add("hidden");
		if (window.playheadAnimationId) {
			cancelAnimationFrame(window.playheadAnimationId);
			window.playheadAnimationId = null;
		}
	});
	player.addEventListener("ended", (event) => {
		// Joined sequence: media end of clip i → hand off to i+1 (do not stop transport)
		if (shouldHandoffToNextJoined()) {
			if (event) event.preventDefault();
			window._sequenceContinuePlay = true;
			void handoffToNextJoinedClip();
			return;
		}

		seektimeupdate();

		let isCurrentlyLooping = false;
		if (window.markerLoopRegistry) {
			isCurrentlyLooping = Object.values(window.markerLoopRegistry).some(
				(state) => state.isSeeking,
			);
		}
		if (
			window.activeLoopId !== null &&
			!String(window.activeLoopId).startsWith("exhausted_")
		) {
			isCurrentlyLooping = true;
		}

		if (isCurrentlyLooping) {
			if (event) event.preventDefault();
			return;
		}

		if (window.playheadAnimationId) {
			cancelAnimationFrame(window.playheadAnimationId);
			window.playheadAnimationId = null;
		}
	});
	player.addEventListener("seeking", () => {
		window.lastCheckedVideoTime = player.currentTime;
		if (window.playheadAnimationId) {
			cancelAnimationFrame(window.playheadAnimationId);
			window.playheadAnimationId = null;
		}
	});

	addMarkerBtn = document.getElementById("addMarkerBtn");
	projectSaveAsButton = document.getElementById("projectSaveAsButton");
	projectImportButton = document.getElementById("projectImportButton");
	newProjectButton = document.getElementById("newProjectButton");
	packageBtn = document.getElementById("packageBtn");
	loadVideoButton = document.getElementById("loadVideoButton");
	speedSlider = document.getElementById("speedSlider");
	seekBar = document.getElementById("seekBar");
	playPauseButton = document.getElementById("playPauseButton");
	jumpToStartButton = document.getElementById("jumpToStartButton");
	rewind5sButton = document.getElementById("rewind5sButton");
	rewind1sButton = document.getElementById("rewind1sButton");
	forward1sButton = document.getElementById("forward1sButton");
	forward5sButton = document.getElementById("forward5sButton");
	muteButton = document.getElementById("muteButton");
	volumeSlider = document.getElementById("volumeSlider");

	loadLocalState();

	// Ensure Playlist Queue Join chips match restored joinedToNext without
	// requiring the user to open/close the sidebar (bug 6).
	if (typeof renderVideoQueueSelect === "function") renderVideoQueueSelect();
	if (typeof window.refreshSidebarPlaylist === "function") {
		window.refreshSidebarPlaylist();
	} else if (typeof window.renderSidebarPlaylist === "function") {
		// Invalidate cache so join state is not sticky from a pre-load shell
		if (typeof window.invalidateSidebarPlaylistCache === "function") {
			window.invalidateSidebarPlaylistCache();
		}
		window.renderSidebarPlaylist();
	}

	// Rehydrate active media through the proxy path (H.265-safe) ONLY if intended mode is Normal.
	// loadLocalState only restores memory; it no longer sets player.src.
	if (window.currentViewMode === "normal") {
		if (videoFilePath && window.__TAURI__) {
			window.loadVideo(videoFilePath).catch((err) => {
				toConsole("Error rehydrating video on startup", err, debuggin);
			});
		} else if (videoFileName && videoBlobCache[videoFileName]) {
			// Browser blob cache — intentional exception (no filesystem path)
			player.src = videoBlobCache[videoFileName];
			player.preload = "metadata";
			player.load();
			toggleVideoPlaceholder(false);
			updateLoadButtonColor();
		}
	}

	updateMarkersList();

	// Wire up Save / Save As / Package buttons
	projectExportButton?.addEventListener("click", () => exportToJSON(false));
	projectSaveAsButton?.addEventListener("click", () => exportToJSON(true));
	packageBtn?.addEventListener("click", async () => {
		const isTauri = window.__TAURI__ !== undefined;
		if (!isTauri) {
			showToast("Packaging requires the desktop app.", "error");
			return;
		}

		// --- helpers to drive the progress modal ---
		const modal = document.getElementById("packageProgressModal");
		const pkgTitle = document.getElementById("pkgModalTitle");
		const pkgStatus = document.getElementById("pkgStatusMessage");
		const pkgBar = document.getElementById("pkgProgressBar");
		const pkgPct = document.getElementById("pkgPercent");
		const pkgCounter = document.getElementById("pkgFileCounter");
		const pkgSpinner = document.getElementById("pkgSpinner");
		const pkgDoneIcon = document.getElementById("pkgDoneIcon");
		const pkgDoneFooter = document.getElementById("pkgDoneFooter");
		const pkgCloseBtn = document.getElementById("pkgCloseBtn");

		const resetModal = () => {
			pkgTitle.textContent = "Packaging Project…";
			pkgStatus.textContent = "Preparing…";
			pkgBar.style.width = "0%";
			pkgPct.textContent = "0%";
			pkgCounter.textContent = "";
			pkgSpinner.classList.remove("hidden");
			pkgDoneIcon.classList.add("hidden");
			pkgDoneFooter.classList.add("hidden");
		};

		const updateModal = ({ step, percent, message, current, total }) => {
			pkgBar.style.width = `${percent}%`;
			pkgPct.textContent = `${percent}%`;
			pkgStatus.textContent = message;
			if (total > 0 && (step === "video" || step === "extract")) {
				pkgCounter.textContent = `File ${current} of ${total}`;
			}
			if (step === "done") {
				pkgTitle.textContent = "Package Complete";
				pkgSpinner.classList.add("hidden");
				pkgDoneIcon.classList.remove("hidden");
				pkgDoneFooter.classList.remove("hidden");
				pkgBar.classList.replace("bg-blue-600", "bg-green-500");
			}
		};

		try {
			// Sync state to localStorage first
			saveLocalState();
			const projectJson =
				localStorage.getItem("lfvideo_project") ||
				localStorage.getItem("timeStudyData") ||
				"{}";
			const videoPaths = (videoQueue || [])
				.map((v) => v.videoFilePath || "")
				.filter((p) => p.length > 0);

			const defaultName = projectName
				? `${sanitizeFilename(projectName)}.lsvz`
				: "project.lsvz";
			const filePath = await window.__TAURI__.dialog.save({
				filters: [{ name: "LS.Video Package", extensions: ["lsvz", "tmvz"] }],
				defaultPath: defaultName,
			});
			if (!filePath) return;

			const actualPath =
				typeof filePath === "object" ? filePath.path : filePath;

			// Open modal and subscribe to progress events
			resetModal();
			modal.showModal();

			let unlisten = null;
			unlisten = await window.__TAURI__.event.listen(
				"package-progress",
				(event) => {
					updateModal(event.payload);
					if (event.payload.step === "done") {
						// Unlisten after a tick so the final update renders first
						setTimeout(() => {
							if (unlisten) {
								unlisten();
								unlisten = null;
							}
						}, 200);
					}
				},
			);

			// Wire the close button
			const onClose = () => {
				modal.close();
				pkgBar.classList.replace("bg-green-500", "bg-blue-600");
			};
			pkgCloseBtn?.addEventListener("click", onClose, { once: true });

			try {
				await window.__TAURI__.core.invoke("save_tspz_bundle", {
					projectJson,
					videoPaths,
					outputPath: actualPath,
				});
			} catch (invokeErr) {
				// Clean up listener and modal on Rust-side error
				if (unlisten) {
					unlisten();
					unlisten = null;
				}
				modal.close();
				pkgBar.classList.replace("bg-green-500", "bg-blue-600");
				throw invokeErr;
			}
		} catch (e) {
			toConsole("Error packaging project", e, debuggin);
			showToast(`Error packaging project: ${e?.message || e}`, "error");
		}
	});

	// Intentional exception: HTTP(S) URL rehydrate — not a filesystem path
	const urlParams = new URLSearchParams(window.location.search);
	const videoUrl = urlParams.get("v");
	if (videoUrl) {
		toConsole("Found video URL in GET parameter", videoUrl, debuggin);
		window.resetClosedCaptions();
		videoFileName = videoUrl.split("/").pop().split("?")[0] || videoUrl;
		player.src = videoUrl;
		player.load();
		toggleVideoPlaceholder(false);
		updateLoadButtonColor();
		saveLocalState();
	}

	// #addMarkerBtn is re-created inside updateMarkersList; binding is handled there
	// (and via #markersList event delegation). Enter/"m" call addMarker() directly.

	projectImportButton?.addEventListener("click", async () => {
		const isTauri = window.__TAURI__ !== undefined;
		if (isTauri) {
			try {
				const selected = await window.__TAURI__.dialog.open({
					multiple: false,
					filters: [
						{
							name: "LS.Video Project / Package",
							extensions: ["lsv", "lsvz", "tmv", "tmvz"],
						},
					],
				});
				if (!selected) return;

				const selectedPath =
					typeof selected === "object" ? selected.path : selected;
				const lower = selectedPath.toLowerCase();

				if (lower.endsWith(".lsvz") || lower.endsWith(".tmvz")) {
					// --- Bundle load path ---
					toConsole("Loading package bundle", selectedPath, debuggin);
					showToast("Extracting bundle…", "info");

					const optimizationOverlayNode =
						document.getElementById("optimizingOverlay");
					if (optimizationOverlayNode) {
						const titleEl = optimizationOverlayNode.querySelector("h3");
						const descEl = optimizationOverlayNode.querySelector("p");
						if (titleEl) titleEl.textContent = "Extracting Project Archive...";
						if (descEl)
							descEl.textContent =
								"Unpacking compressed project folders, please wait...";
						optimizationOverlayNode.classList.remove("hidden");
						optimizationOverlayNode.classList.add("opacity-100", "flex");
					}

					try {
						const result = await window.__TAURI__.core.invoke(
							"load_tspz_bundle",
							{
								bundlePath: selectedPath,
							},
						);

						// skipVideoLoad: re-link extracted temp paths before proxy load
						importFromJSON(result.project_json, { skipVideoLoad: true });

						// Re-link each video using the extracted temp paths
						if (result.video_paths && result.video_paths.length > 0) {
							result.video_paths.forEach((tempPath, i) => {
								if (videoQueue[i]) {
									videoQueue[i].videoFilePath = tempPath;
									videoQueue[i].videoFileName = tempPath.replace(
										/^.*[\\/]/,
										"",
									);
								}
							});
							const active = videoQueue[activeQueueIndex];
							if (active?.videoFilePath) {
								videoFilePath = active.videoFilePath;
								videoFileName = active.videoFileName || "";
								await window.loadVideo(active.videoFilePath);
							}
							saveLocalState();
							renderVideoQueueSelect();
						}

						showToast("Bundle loaded successfully.", "success");
					} catch (bundleErr) {
						toConsole("Error loading package bundle", bundleErr, debuggin);
						showToast(
							`Error loading bundle: ${bundleErr?.message || bundleErr}`,
							"error",
						);
					} finally {
						if (optimizationOverlayNode) {
							optimizationOverlayNode.classList.remove("opacity-100");
							setTimeout(() => {
								optimizationOverlayNode.classList.add("hidden");
								const titleEl = optimizationOverlayNode.querySelector("h3");
								const descEl = optimizationOverlayNode.querySelector("p");
								if (titleEl)
									titleEl.textContent = "Optimizing High-Efficiency Media";
								if (descEl)
									descEl.textContent =
										"Processing H.265/HEVC tracking sequences to generate a frame-accurate proxy timeline track. This occurs once per video asset. Please keep this window active...";
							}, 300);
						}
					}
				} else {
					// --- Standard .tmv load path ---
					projectFilePath = selectedPath;
					localStorage.setItem("projectFilePath", projectFilePath);
					const jsonText =
						await window.__TAURI__.fs.readTextFile(projectFilePath);
					await importFromJSON(jsonText);
				}
			} catch (e) {
				toConsole("Error loading project via Tauri", e, debuggin);
				alert(`Tauri Error (Project Load): ${e.message || JSON.stringify(e)}`);
				showToast("Error loading project file.", "error");
			}
		} else {
			DOM.projectFileInput.click();
		}
	});

	newProjectButton?.addEventListener("click", async () => {
		if (markers.length > 0 || player.getAttribute("src")) {
			const proceed = await asyncConfirm(
				"Are you sure you want to start a new project? All unsaved data will be lost.",
				"New Project",
			);
			if (!proceed) return;
		}

		// Single reset path — clearAllPreviousProjectData owns full wipe + UI sync
		window.clearAllPreviousProjectData();
		showToast("New project started.", "success");
	});
	loadVideoButton?.addEventListener("click", async () => {
		const isTauri = window.__TAURI__ !== undefined;
		if (isTauri) {
			try {
				const selected = await window.__TAURI__.dialog.open({
					multiple: false,
					filters: [
						{
							name: "Media Files",
							extensions: [
								"mp4",
								"webm",
								"ogg",
								"mov",
								"avi",
								"mkv",
								"mp3",
								"wav",
								"flac",
								"aac",
								"m4a",
							],
						},
					],
				});
				if (selected) {
					await processNewVideoFile(selected, true);
				}
			} catch (e) {
				toConsole("Error opening video via Tauri", e, debuggin);
				alert(`Tauri Error (Video Load): ${e.message || JSON.stringify(e)}`);
			}
		} else {
			DOM.videoFileInput.click();
		}
	});

	DOM.videoPlaceholder.addEventListener("click", async () => {
		if (isQueueIndexJoined(activeQueueIndex)) {
			showToast(
				"Unjoin first before loading or replacing media on this queue item.",
				"error",
			);
			return;
		}
		const isTauri = window.__TAURI__ !== undefined;
		if (isTauri) {
			try {
				const selected = await window.__TAURI__.dialog.open({
					multiple: false,
					filters: [
						{
							name: "Media Files",
							extensions: [
								"mp4",
								"webm",
								"ogg",
								"mov",
								"avi",
								"mkv",
								"mp3",
								"wav",
								"flac",
								"aac",
								"m4a",
							],
						},
					],
				});
				if (selected) {
					await processNewVideoFile(selected, true);
				}
			} catch (e) {
				toConsole("Error opening video via Tauri", e, debuggin);
				alert(
					`Tauri Error (Video Placeholder): ${e.message || JSON.stringify(e)}`,
				);
			}
		} else {
			DOM.videoFileInput.click();
			toConsole("Video placeholder clicked", "Triggered Load Video", debuggin);
		}
	});

	playPauseButton.addEventListener("click", () => {
		if (player.paused) {
			void player
				.play()
				?.catch((e) =>
					console.warn("[Playback] play() blocked or unsupported:", e),
				);
		} else {
			player.pause();
		}
	});

	jumpToStartButton.addEventListener("click", () => {
		player.currentTime = clipInTime || 0;
		toConsole("Jumped to Start", player.currentTime, debuggin);
	});

	rewind5sButton.addEventListener("click", () => {
		void seekRelativeInActiveRun(-5);
		toConsole("Rewind 5s", player.currentTime, debuggin);
	});
	rewind1sButton.addEventListener("click", () => {
		void seekRelativeInActiveRun(-1);
		toConsole("Rewind 1s", player.currentTime, debuggin);
	});
	forward1sButton.addEventListener("click", () => {
		void seekRelativeInActiveRun(1);
		toConsole("Forward 1s", player.currentTime, debuggin);
	});
	forward5sButton.addEventListener("click", () => {
		void seekRelativeInActiveRun(5);
		toConsole("Forward 5s", player.currentTime, debuggin);
	});

	// Help Modal Logic
	const helpModal = document.getElementById("helpModal");
	const openHelpBtn = document.getElementById("openHelpBtn");
	const closeHelpBtn = document.getElementById("closeHelpBtn");
	const closeHelpBtnX = document.getElementById("closeHelpBtnX");

	if (openHelpBtn)
		openHelpBtn.addEventListener("click", () => helpModal.showModal());
	const closeModal = () => helpModal.close();
	if (closeHelpBtn) closeHelpBtn.addEventListener("click", closeModal);
	if (closeHelpBtnX) closeHelpBtnX.addEventListener("click", closeModal);

	muteButton.addEventListener("click", () => {
		const nextMuted = !player.muted;
		let vol = clampVolume01(volumeLevel);
		if (!nextMuted && vol === 0) {
			vol = 1;
		}
		applyTransportVolume(vol, nextMuted);
		rememberVolumeOnQueueIndex(activeQueueIndex, vol, nextMuted);
		toConsole("Mute toggled", nextMuted, debuggin);
		saveLocalState();
	});

	volumeSlider.addEventListener(
		"input",
		debounce((event) => {
			const volume = clampVolume01(Number.parseFloat(event.target.value));
			if (!Number.isNaN(volume)) {
				const muted = volume === 0;
				applyTransportVolume(volume, muted);
				// User-set volume is remembered on this clip for later join handoffs
				rememberVolumeOnQueueIndex(activeQueueIndex, volume, muted);
				toConsole("Volume adjusted", volume, debuggin);
				saveLocalState();
			}
		}, 100),
	);

	if (speedSlider) {
		/*
		 * Slider policy:
		 * - No active Speed marker covering playhead → slider sets free playbackRate
		 *   and global playbackSpeed (used when no Speed markers exist).
		 * - Active Speed marker → slider shows/snaps to that marker's speedValue;
		 *   dragging UPDATES the active marker's speedValue so export matches audio.
		 */
		speedSlider.addEventListener(
			"input",
			debounce((event) => {
				const speed = clampSpeedValue(event.target.value);
				if (!Number.isFinite(speed)) return;
				const activeIdx = window._activeSpeedMarkerIndex;
				if (
					typeof activeIdx === "number" &&
					activeIdx >= 0 &&
					markers?.[activeIdx]?.type === "speed"
				) {
					markers[activeIdx].speedValue = speed;
					markers[activeIdx].type = "speed";
					if (player) player.playbackRate = speed;
					if (DOM.speedValue)
						DOM.speedValue.textContent = `${speed.toFixed(speed % 1 === 0 ? 1 : 2)}x`;
					saveLocalState();
					if (typeof window.updateMarkersList === "function") {
						window.updateMarkersList();
					}
					if (typeof window.scheduleSpeedTimelineRebuild === "function") {
						window.scheduleSpeedTimelineRebuild();
					}
					toConsole("Speed slider → active Speed marker", {
						index: activeIdx,
						speed,
					}, debuggin);
				} else {
					if (player) player.playbackRate = speed;
					playbackSpeed = speed;
					if (DOM.speedValue)
						DOM.speedValue.textContent = `${speed.toFixed(1)}x`;
					toConsole("Speed slider input event fired", speed, debuggin);
					saveLocalState();
				}
			}, 100),
		);

		speedSlider.value = playbackSpeed;
		DOM.speedValue.textContent = `${playbackSpeed.toFixed(1)}x`;
	}

	if (seekBar) {
		seekBar.addEventListener("input", (event) => {
			let time = Number.parseFloat(event.target.value);
			if (Number.isNaN(time)) return;

			const run = getActiveJoinRun();
			const multi = run.segments.length > 1;

			if (multi) {
				// Sequence-time scrub (0..total); no solo local clipOut clamp
				const total = Math.max(run.totalDuration, 0.001);
				time = Math.max(0, Math.min(total, time));
				if (typeof seekSequenceTime === "function") {
					void seekSequenceTime(time, { silent: true });
				}
				const pct = (time / total) * 100;
				for (let i = 0; i < playheadsLiveCollection.length; i++) {
					playheadsLiveCollection[i].style.left = `${pct}%`;
				}
				return;
			}

			// Solo: seek bar may be effective (speed-warped) time — map to source
			const speedModel =
				typeof window.getActiveSpeedTimelineModel === "function"
					? window.getActiveSpeedTimelineModel()
					: null;
			if (speedModel?.hasSpeedMarkers) {
				const eff = Math.max(
					0,
					Math.min(speedModel.effectiveDuration, time),
				);
				time = effectiveTimeToSource(eff, speedModel.ranges);
			}
			// Constrain to clipIn/Out on local media clock
			if (clipInTime > 0 && time < clipInTime) time = clipInTime;
			if (clipOutTime > 0 && time > clipOutTime) time = clipOutTime;
			player.currentTime = time;
			const duration = player.duration || 1;
			const pct = (time / duration) * 100;
			for (let i = 0; i < playheadsLiveCollection.length; i++) {
				playheadsLiveCollection[i].style.left = `${pct}%`;
			}
		});
		seekBar.addEventListener("mouseup", (e) => e.target.blur());
		seekBar.addEventListener("touchend", (e) => e.target.blur());
	}

	DOM.videoFileInput.addEventListener("change", async (event) => {
		const file = event.target.files[0];
		if (!file) {
			toConsole("No video file selected", null, debuggin);
			return;
		}
		await processNewVideoFile(file, false);
		event.target.value = ""; // Reset input so the same file can be loaded again if needed
	});

	DOM.projectFileInput.addEventListener("change", (event) => {
		const file = event.target.files[0];
		if (file) {
			const reader = new FileReader();
			reader.onload = (e) => {
				importFromJSON(e.target.result);
			};
			reader.readAsText(file);
		}
		event.target.value = ""; // Reset input so the same file can be loaded again if needed
	});

	DOM.zoomIn.addEventListener("click", () => {
		const container = document.getElementById("video-wrapper-id");
		const centerX = container.offsetWidth / 2;
		const centerY = container.offsetHeight / 2;

		const oldZoom = window.zoomLevel || 1.0;
		const oldX = window.translateX || 0;
		const oldY = window.translateY || 0;

		let targetZoom = oldZoom + 0.1;
		targetZoom = Math.min(15.0, Math.max(1.0, targetZoom));

		const scaleRatio = targetZoom / oldZoom;

		window.zoomLevel = targetZoom;
		window.translateX = centerX - (centerX - oldX) * scaleRatio;
		window.translateY = centerY - (centerY - oldY) * scaleRatio;

		const videoElement = document.querySelector("video");
		updateViewportTransform(videoElement);
		window.triggerPlaybackOverlay(
			`Zoom: ${Math.round(window.zoomLevel * 100)}%`,
		);
	});
	DOM.zoomOut.addEventListener("click", () => {
		const container = document.getElementById("video-wrapper-id");
		const centerX = container.offsetWidth / 2;
		const centerY = container.offsetHeight / 2;

		const oldZoom = window.zoomLevel || 1.0;
		const oldX = window.translateX || 0;
		const oldY = window.translateY || 0;

		let targetZoom = oldZoom - 0.1;
		targetZoom = Math.min(15.0, Math.max(1.0, targetZoom));

		const scaleRatio = targetZoom / oldZoom;

		window.zoomLevel = targetZoom;
		window.translateX = centerX - (centerX - oldX) * scaleRatio;
		window.translateY = centerY - (centerY - oldY) * scaleRatio;

		const videoElement = document.querySelector("video");
		updateViewportTransform(videoElement);
		window.triggerPlaybackOverlay(
			`Zoom: ${Math.round(window.zoomLevel * 100)}%`,
		);
	});
	DOM.resetZoom.addEventListener("click", () => {
		window.zoomLevel = 1.0;
		window.translateX = 0;
		window.translateY = 0;
		updateViewportTransform(document.querySelector("video"));
		//window.triggerPlaybackOverlay("Zoom Reset");
	});
	if (DOM.takeSnapshotBtn) {
		DOM.takeSnapshotBtn.addEventListener("click", takeSnapshot);
	}
	if (DOM.toggleCinemaBtn) {
		DOM.toggleCinemaBtn.addEventListener("click", (e) => {
			e.preventDefault();
			window.cycleViewMode(
				window.currentViewMode === "cinema" ? "normal" : "cinema",
			);
		});
	}
	document.addEventListener("mousemove", resetCinemaIdleTimer);

	const videoWrapper = document.getElementById("video-wrapper-id");
	if (videoWrapper) {
		videoWrapper.addEventListener("mousedown", window.startMarquee);
		videoWrapper.addEventListener("mousemove", window.drawMarquee);
		videoWrapper.addEventListener("mouseup", window.endMarquee);
	}

	const jumpToPreviousMarker = () => {
		const activeVideo =
			(typeof videoQueue !== "undefined" && videoQueue[activeQueueIndex]) || {};
		const currentMarkers =
			activeVideo.markers || activeVideo.appState?.markers || markers || [];
		if (currentMarkers.length === 0) return;

		const sorted = [...currentMarkers].sort(
			(a, b) => a.startTime - b.startTime,
		);
		const currentTime = player.currentTime;

		const target = [...sorted]
			.reverse()
			.find((m) => m.startTime < currentTime - 0.1);
		if (target) {
			player.currentTime = target.startTime;
		} else {
			player.currentTime = 0;
		}
		player.pause();
	};

	const jumpToNextMarker = () => {
		const activeVideo =
			(typeof videoQueue !== "undefined" && videoQueue[activeQueueIndex]) || {};
		const currentMarkers =
			activeVideo.markers || activeVideo.appState?.markers || markers || [];
		if (currentMarkers.length === 0) return;

		const sorted = [...currentMarkers].sort(
			(a, b) => a.startTime - b.startTime,
		);
		const currentTime = player.currentTime;

		const target = sorted.find((m) => m.startTime > currentTime + 0.1);
		if (target) {
			player.currentTime = target.startTime;
		} else {
			player.currentTime = player.duration;
		}
		player.pause();
	};

	document.addEventListener("keydown", async (e) => {
		// Disable shortcuts while Tetris is active to prevent key conflicts (e.g. arrows/spacebar seeking video)
		const tetrisCont = document.getElementById("tetrisContainer");
		if (
			tetrisCont &&
			!tetrisCont.classList.contains("hidden") &&
			tetrisCont.style.display !== "none"
		) {
			return;
		}

		// Global shortcuts (can trigger anywhere)
		if (e.ctrlKey && e.key.toLowerCase() === "s") {
			e.preventDefault();
			if (e.shiftKey) {
				exportToJSON(true);
				toConsole("Shortcut triggered", "Save As", debuggin);
			} else {
				exportToJSON(false);
				toConsole("Shortcut triggered", "Save", debuggin);
			}
			return;
		}

		if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;

		// Esc in Cinema mode → Miniplayer (NOT Normal)
		if (
			window.currentViewMode === "cinema" &&
			(e.key === "Escape" || e.key === "Esc")
		) {
			e.preventDefault();
			await window.cycleViewMode("miniplayer");
			return;
		}

		switch (e.key) {
			case ",":
				e.preventDefault();
				if (!player.src) return;
				jumpToPreviousMarker();
				break;
			case ".":
				e.preventDefault();
				if (!player.src) return;
				jumpToNextMarker();
				break;
			case "\\":
				e.preventDefault();
				window.cycleViewMode();
				break;
			case " ":
				e.preventDefault();
				if (!player.src) return;
				if (player.paused) {
					void player
						.play()
						?.catch((err) =>
							console.warn("[Playback] play() blocked or unsupported:", err),
						);
				} else {
					player.pause();
				}
				break;
			case "t":
			case "T": {
				e.preventDefault();
				const ccBtn = document.getElementById("ccToggleBtn");
				if (ccBtn && !ccBtn.hasAttribute("disabled")) {
					ccBtn.click();
				}
				break;
			}
			case "ArrowLeft":
				e.preventDefault();
				if (!player.src) return;
				void seekRelativeInActiveRun(-1);
				toConsole("Rewind 1s (Left Arrow)", player.currentTime, debuggin);
				break;
			case "ArrowDown":
				e.preventDefault();
				if (!player.src) return;
				void seekRelativeInActiveRun(-5);
				toConsole("Rewind 5s (Down Arrow)", player.currentTime, debuggin);
				break;
			case "ArrowRight":
				e.preventDefault();
				if (!player.src) return;
				void seekRelativeInActiveRun(1);
				toConsole("Forward 1s (Right Arrow)", player.currentTime, debuggin);
				break;
			case "ArrowUp":
				e.preventDefault();
				if (!player.src) return;
				void seekRelativeInActiveRun(5);
				toConsole("Forward 5s (Up Arrow)", player.currentTime, debuggin);
				break;
			case "s":
			case "S":
				e.preventDefault();
				if (!player.src) return;
				takeSnapshot();
				break;
			case "Enter":
			case "m":
				e.preventDefault();
				if (!player.src) return;
				addMarker();
				break;
			case "l":
				e.preventDefault();
				if (loadVideoButton) loadVideoButton.click();
				break;
			case "=":
				e.preventDefault();
				zoomLevel += 0.1;
				updateZoom();
				window.triggerPlaybackOverlay(`Zoom: ${Math.round(zoomLevel * 100)}%`);
				break;
			case "-":
				e.preventDefault();
				zoomLevel = Math.max(0.1, zoomLevel - 0.2);
				updateZoom();
				window.triggerPlaybackOverlay(`Zoom: ${Math.round(zoomLevel * 100)}%`);
				break;
			case "Backspace":
				e.preventDefault();
				zoomLevel = 1;
				translateX = 0;
				translateY = 0;
				updateZoom();
				//window.triggerPlaybackOverlay("Zoom Reset");
				break;
			case "`":
			case "1":
			case "2":
			case "3":
			case "4":
			case "5":
			case "6":
			case "7":
			case "8": {
				e.preventDefault();
				if (!player.src) return;
				const newSpeed = clampSpeedValue(
					e.key === "`" ? 0.5 : Number.parseInt(e.key, 10),
				);
				const activeIdx = window._activeSpeedMarkerIndex;
				if (
					typeof activeIdx === "number" &&
					activeIdx >= 0 &&
					markers?.[activeIdx]?.type === "speed"
				) {
					markers[activeIdx].speedValue = newSpeed;
					saveLocalState();
					if (typeof window.updateMarkersList === "function") {
						window.updateMarkersList();
					}
				} else {
					playbackSpeed = newSpeed;
					saveLocalState();
				}
				player.playbackRate = newSpeed;
				if (speedSlider) speedSlider.value = newSpeed;
				if (DOM.speedValue)
					DOM.speedValue.textContent = `${newSpeed.toFixed(1)}x`;
				toConsole("Playback speed shortcut", newSpeed, debuggin);
				window.triggerPlaybackOverlay(`Speed: ${newSpeed.toFixed(1)}x`);
				break;
			}
		}
	});

	window.addEventListener("beforeunload", (e) => {
		if (markers.length > 0 || player.src) {
			e.preventDefault();
			e.returnValue =
				"You have unsaved changes. Are you sure you want to leave?";
			return e.returnValue;
		}
	});

	updateLoadButtonColor();
};

window.startMarquee = (e) => {
	const targetInput = e?.target || e?.srcElement;
	console.log("utils.js:219 Marquee start:", e?.clientX, e?.clientY);

	if (e?.button !== 0) return;
	if (e?.target?.closest?.(".zoom-controls")) return;
	isDrawing = true;
	const rect = marqueeOverlay.getBoundingClientRect();
	startX = (e?.clientX || 0) - rect.left;
	startY = (e?.clientY || 0) - rect.top;

	// Safe coordinate normalization
	window.marqueeSelectionStartRef = { x: e?.clientX || 0, y: e?.clientY || 0 };
	window.marqueeSelectionEndRef = { x: e?.clientX || 0, y: e?.clientY || 0 };

	// Inject stacking context & display marquee rectangle box
	marqueeRect.style.position = "absolute";
	marqueeRect.style.zIndex = "50";
	marqueeRect.style.pointerEvents = "none";
	marqueeRect.style.left = `${startX}px`;
	marqueeRect.style.top = `${startY}px`;
	marqueeRect.style.width = "0px";
	marqueeRect.style.height = "0px";
	marqueeRect.style.display = "block";
};

window.drawMarquee = (e) => {
	// Guard loop: ignore if tracking states haven't been mounted by startMarquee
	if (!window.marqueeSelectionStartRef) return;
	if (!isDrawing) return;

	// Update ending coordinates continuously on move gestures
	window.marqueeSelectionEndRef = { x: e?.clientX || 0, y: e?.clientY || 0 };

	// Failsafe declaration bindings to guarantee old references never panic
	const selectionStart = window.marqueeSelectionStartRef;
	const selectionEnd = window.marqueeSelectionEndRef;

	const rect = marqueeOverlay.getBoundingClientRect();
	const wrapper = document.getElementById("video-wrapper-id");
	const aspect = wrapper.offsetHeight / wrapper.offsetWidth;

	const widthDelta = Math.abs(e.clientX - (selectionStart?.x || 0));
	const calculatedHeightDelta = widthDelta * aspect;

	let leftStyle = (selectionStart?.x || 0) - rect.left;
	const widthStyle = widthDelta;
	if (e.clientX < (selectionStart?.x || 0)) {
		leftStyle = e.clientX - rect.left;
	}

	let topStyle = (selectionStart?.y || 0) - rect.top;
	const heightStyle = calculatedHeightDelta;
	if (e.clientY < (selectionStart?.y || 0)) {
		topStyle = (selectionStart?.y || 0) - rect.top - calculatedHeightDelta;
	}

	marqueeRect.style.left = `${leftStyle}px`;
	marqueeRect.style.width = `${widthStyle}px`;
	marqueeRect.style.top = `${topStyle}px`;
	marqueeRect.style.height = `${heightStyle}px`;

	if (e.clientY >= (selectionStart?.y || 0)) {
		selectionEnd.y = (selectionStart?.y || 0) + calculatedHeightDelta;
	} else {
		selectionEnd.y = (selectionStart?.y || 0) - calculatedHeightDelta;
	}

	// Example native call trace safety:
	if (typeof window.updateMarqueeOverlay === "function") {
		window.updateMarqueeOverlay(selectionStart, selectionEnd);
	}
};

window.endMarquee = (e) => {
	if (!window.marqueeSelectionStartRef) return;
	if (e?.button !== 0) return;
	isDrawing = false;
	marqueeRect.style.display = "none";

	const selectionStart = window.marqueeSelectionStartRef;
	const selectionEnd = window.marqueeSelectionEndRef || {
		x: e?.clientX || 0,
		y: e?.clientY || 0,
	};

	const videoElement = DOM.video;
	const container = document.getElementById("video-wrapper-id");

	const screenWidth = Math.abs(
		(selectionEnd?.x || 0) - (selectionStart?.x || 0),
	);
	const screenHeight = Math.abs(
		(selectionEnd?.y || 0) - (selectionStart?.y || 0),
	);

	if (screenWidth < 5 || screenHeight < 5) {
		// Reset memory markers cleanly
		window.marqueeSelectionStartRef = null;
		window.marqueeSelectionEndRef = null;
		return;
	}

	const boxCenterX =
		Math.min(selectionEnd?.x || 0, selectionStart?.x || 0) + screenWidth / 2;
	const boxCenterY =
		Math.min(selectionEnd?.y || 0, selectionStart?.y || 0) + screenHeight / 2;

	const containerRect = container.getBoundingClientRect();
	const relativeCenterX = boxCenterX - containerRect.left;
	const relativeCenterY = boxCenterY - containerRect.top;

	const currentZoom = window.zoomLevel || 1.0;
	const currentX = window.translateX || 0;
	const currentY = window.translateY || 0;

	const scaleMultiplier = Math.min(
		container.offsetWidth / screenWidth,
		container.offsetHeight / screenHeight,
	);

	let finalZoom = currentZoom * scaleMultiplier;
	finalZoom = Math.min(15.0, Math.max(1.0, finalZoom));

	window.zoomLevel = finalZoom;
	window.translateX =
		container.offsetWidth / 2 -
		((container.offsetWidth / 2 - currentX) * scaleMultiplier +
			(boxCenterX - (containerRect.left + container.offsetWidth / 2)) *
				scaleMultiplier);
	window.translateY =
		container.offsetHeight / 2 -
		((container.offsetHeight / 2 - currentY) * scaleMultiplier +
			(boxCenterY - (containerRect.top + container.offsetHeight / 2)) *
				scaleMultiplier);

	toConsole(
		"New viewport settings from marquee",
		`Zoom: ${window.zoomLevel}, Translate: (${window.translateX}, ${window.translateY})`,
		debuggin,
	);

	updateViewportTransform(videoElement);

	// Clear memory trackers completely to terminate the drag cycle cleanly
	window.marqueeSelectionStartRef = null;
	window.marqueeSelectionEndRef = null;
};

/** Applies the current zoom and translation transform to the video element. */
const updateZoom = () => {
	const video = DOM.video;
	updateViewportTransform(video);
	toConsole(
		"Zoom updated",
		`Level: ${zoomLevel}, Translate: (${translateX}, ${translateY})`,
		debuggin,
	);
};

/** Synchronizes timeline playheads, looping state, and UI on video time update. */
const seektimeupdate = () => {
	if (player && playerReady) {
		// Absolute DOM Overwrite Container Protection
		if (!window.currentCaptions || window.currentCaptions.length === 0) {
			const ccDisplay = document.getElementById("cc-output");
			if (ccDisplay) {
				ccDisplay.innerHTML = "";
			}
		}

		// Do not fight the player mid-handoff load
		if (window._sequenceHandoffInProgress) return;

		// Soft clip-edge fade preview (opacity + volume ramp)
		if (typeof window.applyClipEdgeFadePreview === "function") {
			window.applyClipEdgeFadePreview();
		}
		if (typeof window.ensureClipFadePreviewLoop === "function") {
			window.ensureClipFadePreviewLoop();
		}
		// Speed marker → playbackRate + slider snap
		if (typeof window.applyActiveSpeedPlayback === "function") {
			window.applyActiveSpeedPlayback();
		}

		const currentTime = player.currentTime;
		const duration = player.duration;
		const run = getActiveJoinRun();
		const multi = run.segments.length > 1;
		if (multi) syncSequenceModeState(run);

		// Transport clock: sequence/effective time when multi or Speed markers, else local
		const speedModel =
			!multi && typeof window.getActiveSpeedTimelineModel === "function"
				? window.getActiveSpeedTimelineModel()
				: null;
		const displayTime = multi
			? getSequencePlayheadTime()
			: speedModel?.hasSpeedMarkers
				? sourceTimeToEffective(currentTime, speedModel.ranges)
				: currentTime;
		const displayDuration = multi
			? Math.max(run.totalDuration, 0.001)
			: speedModel?.hasSpeedMarkers
				? speedModel.effectiveDuration
				: duration || 0;

		if (seekBar) {
			if (multi) {
				// Multi: bar is SEQUENCE (0..total) — not local media
				seekBar.max = displayDuration;
				seekBar.value = displayTime;
			} else if (speedModel?.hasSpeedMarkers) {
				seekBar.max = displayDuration;
				seekBar.value = displayTime;
			} else {
				seekBar.max = duration || 0;
				seekBar.value = currentTime;
			}
		}

		updateTimeDisplay(displayTime, "currentTime");
		if (displayDuration) {
			updateTimeDisplay(displayDuration, "durationTime");
		}

		// Playhead on detailed timeline — effective % (sequence or speed-warped solo)
		if (multi && run.totalDuration > 0) {
			const seqPct = (displayTime / run.totalDuration) * 100;
			for (let i = 0; i < playheadsLiveCollection.length; i++) {
				playheadsLiveCollection[i].style.left = `${seqPct}%`;
			}
		} else if (displayDuration > 0) {
			const pct = (displayTime / displayDuration) * 100;
			for (let i = 0; i < playheadsLiveCollection.length; i++) {
				playheadsLiveCollection[i].style.left = `${pct}%`;
			}
		}

		// Playhead Execution Logic: Jump & Loop
		if (markers && markers.length > 0) {
			const activeVideo =
				(typeof videoQueue !== "undefined" && videoQueue[activeQueueIndex]) ||
				{};
			const endLimit =
				activeVideo.virtualEndTime !== null &&
				activeVideo.virtualEndTime !== undefined
					? activeVideo.virtualEndTime
					: duration || player.duration || 0;

			for (let j = 0; j < markers.length; j += 1) {
				const currentMarker = markers[j];
				const nextMarker = markers[j + 1];
				const boundaryTime = nextMarker ? nextMarker.startTime : endLimit;

				if (currentMarker.type === "jump") {
					if (
						currentTime >= currentMarker.startTime &&
						currentTime < boundaryTime
					) {
						player.currentTime = boundaryTime;
						return;
					}
				} else if (currentMarker.type === "loop") {
					const video = player;
					const marker = currentMarker;

					const subsequentMarkers = markers
						.filter((m) => m.startTime > marker.startTime)
						.sort((a, b) => a.startTime - b.startTime);

					const computedLoopEnd =
						subsequentMarkers.length > 0
							? subsequentMarkers[0].startTime
							: video.duration;
					const loopEndThreshold = computedLoopEnd - 0.3;

					if (
						video.currentTime >= marker.startTime &&
						video.currentTime < loopEndThreshold
					) {
						if (
							window.activeLoopId !== marker.id &&
							window.activeLoopId !== `exhausted_${marker.id}`
						) {
							window.activeLoopId = marker.id;
							window.activeLoopCount = 0;
						}
					}

					if (video.currentTime >= loopEndThreshold) {
						if (window.activeLoopId === marker.id) {
							if (window.activeLoopCount + 1 < (marker.loopCount || 1)) {
								window.activeLoopCount++;
								video.currentTime = marker.startTime;
								void video
									.play()
									?.catch((err) =>
										console.warn(
											"[Playback] loop play() blocked or unsupported:",
											err,
										),
									);
							} else {
								window.activeLoopId = `exhausted_${marker.id}`;
							}
						}
					}

					if (
						video.currentTime < marker.startTime - 0.5 ||
						video.currentTime > computedLoopEnd + 0.5
					) {
						if (
							window.activeLoopId === marker.id ||
							window.activeLoopId === `exhausted_${marker.id}`
						) {
							window.activeLoopId = null;
							window.activeLoopCount = 0;
						}
					}
				}
			}
		}

		// Constrain seek if we try to go before the clipInTime
		if (clipInTime > 0 && currentTime < clipInTime) {
			player.currentTime = clipInTime;
			return;
		}

		// At clipOut / media end: hand off to next joined clip, or stop as today
		if (isAtOrPastClipOut(currentTime)) {
			const playingThrough =
				!player.paused || !!player.ended || !!window._sequenceContinuePlay;
			if (shouldHandoffToNextJoined() && playingThrough) {
				// Sequence-continue — do not treat as "video ended / stop"
				window._sequenceContinuePlay = true;
				void handoffToNextJoinedClip();
				return;
			}
			// Solo (or unjoined): stop once while playing; avoid seek-loop when already parked
			if (!player.paused) {
				player.pause();
				const out = getEffectiveClipOut();
				if (out > 0 && Number.isFinite(out) && currentTime > out + 0.001) {
					try {
						player.currentTime = Math.min(out, player.duration || out);
					} catch (_) {
						/* ignore */
					}
				}
			}
			return;
		}
	}
};

/** Redraws visual ticks for markers and process boundaries on the seek bar. */
const updateSliderTicks = () => {
	if (!DOM.startTick || !DOM.endTick) return;

	if (DOM.markerTicksContainer) {
		DOM.markerTicksContainer.innerHTML = "";
	}
	DOM.startTick.classList.add("hidden");
	if (DOM.startGreyOut) DOM.startGreyOut.classList.add("hidden");
	DOM.endTick.classList.add("hidden");
	if (DOM.endGreyOut) DOM.endGreyOut.classList.add("hidden");

	const run =
		typeof getActiveJoinRun === "function" ? getActiveJoinRun() : null;
	const multiClipRun = !!(run?.segments && run.segments.length > 1);
	const seqTotal = Math.max(Number(run?.totalDuration) || 0, 0);

	// Multi-clip: transport bar is SEQUENCE time (0..total). Solo: local media time.
	if (multiClipRun) {
		if (seqTotal <= 0) return;
		if (typeof seekBar !== "undefined" && seekBar) {
			seekBar.max = seqTotal;
		}
		// Sequence starts at 0 — no leading grey. No solo local-clipOut tail shade.
		// Optional: nothing past sequence end (max already = total).
		if (DOM.markerTicksContainer) {
			// All run markers in sequence time
			for (const seg of run.segments) {
				const list =
					seg.queueIndex === activeQueueIndex
						? markers || []
						: seg.video?.appState?.markers || [];
				for (const m of list) {
					const seqT =
						typeof sourceTimeToSequence === "function"
							? sourceTimeToSequence(seg.queueIndex, m.startTime, run)
							: m.startTime;
					if (seqT < 0 || seqT > seqTotal) continue;
					const pct = (seqT / seqTotal) * 100;
					const tick = document.createElement("div");
					tick.className =
						"absolute h-3 w-0.5 bg-yellow-500 top-1/2 -translate-y-1/2 cursor-pointer transition-colors hover:bg-yellow-400";
					tick.style.pointerEvents = "auto";
					tick.style.left = `calc(${pct}% - 1px)`;
					tick.title = m.name;
					tick.addEventListener("click", () => {
						if (typeof seekSequenceTime === "function") {
							void seekSequenceTime(seqT, { silent: true });
						}
					});
					DOM.markerTicksContainer.appendChild(tick);
				}
			}
		}
		return;
	}

	// -------- Solo / single-clip: local media bar + clipIn/Out grey --------
	if (!player?.duration) return;

	if (typeof seekBar !== "undefined" && seekBar) {
		seekBar.max = player.duration || 0;
	}

	if (clipInTime > 0) {
		const startPct = (clipInTime / player.duration) * 100;
		DOM.startTick.style.left = `calc(${startPct}% - 1px)`;
		DOM.startTick.classList.remove("hidden");
		if (DOM.startGreyOut) {
			DOM.startGreyOut.style.width = `${startPct}%`;
			DOM.startGreyOut.classList.remove("hidden");
		}
	}

	if (clipOutTime > 0 && clipOutTime < player.duration) {
		const endPct = (clipOutTime / player.duration) * 100;
		DOM.endTick.style.left = `calc(${endPct}% - 1px)`;
		DOM.endTick.classList.remove("hidden");
		if (DOM.endGreyOut) {
			DOM.endGreyOut.style.width = `${100 - endPct}%`;
			DOM.endGreyOut.classList.remove("hidden");
		}
	} else {
		DOM.endTick.classList.add("hidden");
		if (DOM.endGreyOut) DOM.endGreyOut.classList.add("hidden");
	}

	if (DOM.markerTicksContainer) {
		DOM.markerTicksContainer.innerHTML = "";
		markers.forEach((m) => {
			if (m.startTime >= 0 && m.startTime <= player.duration) {
				const pct = (m.startTime / player.duration) * 100;
				const tick = document.createElement("div");
				tick.className =
					"absolute h-3 w-0.5 bg-yellow-500 top-1/2 -translate-y-1/2 cursor-pointer transition-colors hover:bg-yellow-400";
				tick.style.pointerEvents = "auto";
				tick.style.left = `calc(${pct}% - 1px)`;
				tick.title = m.name;
				tick.addEventListener("click", () => {
					player.currentTime = m.startTime;
				});
				DOM.markerTicksContainer.appendChild(tick);
			}
		});
	}
};

/** Formats and outputs the video time to the specified DOM element. */
const updateTimeDisplay = (seconds, elementId) => {
	DOM[elementId].textContent = formatTimeToHHMMSSMS(seconds);
};

/** Repositions control bar dynamically based on video dimensions. */
const positionControls = () => {
	const controlsBar = document.getElementById("video_controls_bar");
	if (controlsBar) {
		controlsBar.style.position = "relative";
		toConsole("Controls repositioned after video load", "Success", debuggin);
	}
};

/** Updates the load video button visual styling based on player load state. */
const updateLoadButtonColor = () => {
	if (loadVideoButton && player && playPauseButton) {
		// Disable folder/load while active queue item is part of a join
		const joined = isQueueIndexJoined(activeQueueIndex);
		loadVideoButton.disabled = joined;
		loadVideoButton.title = joined
			? "Unjoin first before loading or replacing media"
			: "Load Video";
		loadVideoButton.classList.toggle("opacity-40", joined);
		loadVideoButton.classList.toggle("cursor-not-allowed", joined);

		const src = player.getAttribute("src");
		if (!src) {
			loadVideoButton.classList.add("btn-icon-highlight");
			loadVideoButton.classList.remove("btn-icon");
			playPauseButton.disabled = true;
			jumpToStartButton.disabled = true;
			rewind5sButton.disabled = true;
			rewind1sButton.disabled = true;
			forward1sButton.disabled = true;
			forward5sButton.disabled = true;
			muteButton.disabled = true;
			volumeSlider.disabled = true;
		} else {
			loadVideoButton.classList.remove("btn-icon-highlight");
			loadVideoButton.classList.add("btn-icon");
			playPauseButton.disabled = false;
			jumpToStartButton.disabled = false;
			rewind5sButton.disabled = false;
			rewind1sButton.disabled = false;
			forward1sButton.disabled = false;
			forward5sButton.disabled = false;
			muteButton.disabled = false;
			volumeSlider.disabled = false;
		}
	}
};
// Exposed for classic scripts (state.js) and loadVideo post-load UI sync
window.updateLoadButtonColor = updateLoadButtonColor;

/** Toggles the visibility of the "no video loaded" placeholder element. */
const toggleVideoPlaceholder = (show) => {
	try {
		if (!DOM.videoPlaceholder || !DOM.videoWrapper) {
			throw new Error("Video placeholder or wrapper element not found");
		}
		if (show) {
			toConsole("Showing placeholder, hiding video wrapper", null, debuggin);
			DOM.videoPlaceholder.style.display = "flex";
			DOM.videoWrapper.style.display = "none";
		} else {
			toConsole("Hiding placeholder, showing video wrapper", null, debuggin);
			DOM.videoPlaceholder.style.display = "none";
			DOM.videoWrapper.style.display = "block";
		}
	} catch (error) {
		toConsole("toggleVideoPlaceholder error", error.message, debuggin);
		alert(
			"Failed to toggle video placeholder. Please check the console for details.",
		);
	}
};
window.toggleVideoPlaceholder = toggleVideoPlaceholder;

/** Opens or closes the settings side panel. */
const toggleSettings = (show) => {
	if (!DOM.settingsPanel || !DOM.settingsBackdrop) return;
	if (show) {
		DOM.settingsBackdrop.classList.remove("hidden");
		requestAnimationFrame(() => {
			DOM.settingsBackdrop.classList.remove("opacity-0");
			DOM.settingsPanel.classList.remove("translate-x-full");
		});
		if (DOM.projectCommentsInput)
			DOM.projectCommentsInput.value = projectComments || "";
	} else {
		DOM.settingsPanel.classList.add("translate-x-full");
		DOM.settingsBackdrop.classList.add("opacity-0");
		setTimeout(() => DOM.settingsBackdrop.classList.add("hidden"), 300);
	}
};

/**
 * Next auto-name "Marker N" unique within the active join run (or solo source).
 * Stored data stays source-local; only the default label uses sequence/run context.
 */
const getNextRunMarkerDefaultName = () => {
	const used = new Set();
	const collect = (list) => {
		if (!Array.isArray(list)) return;
		for (const m of list) {
			if (m?.name) used.add(String(m.name));
		}
	};

	const multi =
		typeof isActiveRunMulti === "function"
			? isActiveRunMulti()
			: typeof window.isActiveRunMulti === "function" &&
				window.isActiveRunMulti();
	if (multi) {
		const run =
			typeof getActiveJoinRun === "function"
				? getActiveJoinRun()
				: typeof window.getActiveJoinRun === "function"
					? window.getActiveJoinRun()
					: null;
		if (run?.segments?.length) {
			for (const seg of run.segments) {
				if (seg.queueIndex === activeQueueIndex) {
					collect(markers);
				} else {
					collect(seg.video?.appState?.markers);
				}
			}
		} else {
			collect(markers);
		}
	} else {
		collect(markers);
	}

	let n = 1;
	while (used.has(`Marker ${n}`)) n += 1;
	return `Marker ${n}`;
};

/** Inserts a new standard marker at the current video playback time. */
const addMarker = () => {
	if (!player.src) {
		alert("Please load a video first.");
		return;
	}

	const startTime = player.currentTime;
	toConsole("Marker start time", startTime, debuggin);

	if (startTime < clipInTime) {
		showToast("Marker starts before Clip In.", "error");
	} else if (clipOutTime > 0 && startTime > clipOutTime) {
		showToast("Marker starts after Clip Out.", "error");
	}

	// Global next index across the active join run so names do not collide per-file
	const defaultName = getNextRunMarkerDefaultName();

	markers.push({
		id: Date.now(),
		name: defaultName,
		startTime: startTime,
		type: "standard",
	});

	// Keep source-local order by local time only (do not shuffle across files)
	markers.sort((a, b) => a.startTime - b.startTime);

	saveLocalState();
	updateVideoTimeSummary();
	updateMarkersList();
};

/** Renames an existing marker at the given index. */
const updateMarkerName = (markerIndex, newName) => {
	const trimmed = newName.trim();
	if (!trimmed) {
		alert("Marker name cannot be empty.");
		updateMarkersList();
		return;
	}
	const lowerName = trimmed.toLowerCase();
	if (lowerName === "terry" || lowerName === "tetris") {
		window.isSecretGame = true;
		toggleSettings(true);
		if (typeof window.resetTrimModalUI === "function") {
			window.resetTrimModalUI();
		}
		if (typeof window.activateTetris === "function") {
			window.activateTetris();
		}
		updateMarkersList();
		return;
	}
	markers[markerIndex].name = trimmed;
	saveLocalState();
};

/** Updates the behavioral type of an existing marker. */
const updateMarkerType = (markerIndex, newType) => {
	if (!markers[markerIndex]) return;
	markers[markerIndex].type = newType;
	// Preserve existing loopCount when selecting Loop; default to 1 if unset
	if (newType === "loop") {
		markers[markerIndex].loopCount = markers[markerIndex].loopCount || 1;
	}
	// Speed marker: default rate 1.0 when first set
	if (newType === "speed") {
		markers[markerIndex].speedValue = clampSpeedValue(
			markers[markerIndex].speedValue ?? SPEED_DEFAULT,
		);
	}
	// in/out types redefine segment duration on the sequence spine
	const boundsChanged =
		typeof syncClipBoundsFromMarkers === "function"
			? syncClipBoundsFromMarkers(activeQueueIndex)
			: false;
	saveLocalState();
	updateVideoTimeSummary();
	updateMarkersList();
	if (typeof window.paintTimelineMarkersAndShading === "function") {
		window.paintTimelineMarkersAndShading();
	}
	if (typeof updateSliderTicks === "function") updateSliderTicks();
	// Rebuild join row geometry so v1 clipOut shares a flush boundary with v2
	if (
		boundsChanged ||
		newType === "in" ||
		newType === "out" ||
		newType === "start" ||
		newType === "end"
	) {
		if (typeof scheduleJoinTimelineRebuild === "function") {
			scheduleJoinTimelineRebuild();
		}
	}
	if (newType === "speed" || markers[markerIndex]?.type === "speed") {
		if (typeof window.scheduleSpeedTimelineRebuild === "function") {
			window.scheduleSpeedTimelineRebuild();
		}
		if (typeof window.applyActiveSpeedPlayback === "function") {
			window.applyActiveSpeedPlayback();
		}
	}
};

/** Prompts for confirmation and deletes the specified marker. */
const deleteMarker = async (markerIndex) => {
	if (
		await asyncConfirm(
			`Are you sure you want to delete the marker "${markers[markerIndex].name}"? This action cannot be undone.`,
			"Delete Marker",
		)
	) {
		markers.splice(markerIndex, 1);
		toConsole(
			`Deleted marker at index ${markerIndex}`,
			`Total markers left: ${markers.length}`,
			debuggin,
		);
		if (typeof syncClipBoundsFromMarkers === "function") {
			syncClipBoundsFromMarkers(activeQueueIndex);
		}
		saveLocalState();
		updateMarkersList();
		if (typeof updateSliderTicks === "function") updateSliderTicks();
		if (typeof scheduleJoinTimelineRebuild === "function") {
			scheduleJoinTimelineRebuild();
		}
	}
};

/** Seeks the video player to the target marker start or end time and pauses. */
const jumpToMarkerTime = (markerIndexOrTime, type) => {
	if (!player.src) {
		alert("Please load a video first.");
		return;
	}
	window.currentLoopCount = 0;
	window.activeLoopMarkerId = null;
	let time;
	if (type === undefined) {
		time = Number.parseFloat(markerIndexOrTime);
	} else {
		const marker = markers[markerIndexOrTime];
		if (!marker) return;
		time = type === "start" ? marker.startTime : marker.endTime;
	}
	if (time !== undefined && time !== null) {
		// Always pause — matches "Jump here (Paused)" control label
		player.pause();
		player.currentTime = time;
		// Some engines auto-resume after seek while readyState changes; re-assert pause
		const ensurePaused = () => {
			if (!player.paused) player.pause();
		};
		player.addEventListener("seeked", ensurePaused, { once: true });
		requestAnimationFrame(ensurePaused);
		toConsole("Jumped to marker time", time, debuggin);
	}
};

/** Seeks the video player to the target marker time and initiates playback. */
const playFromMarkerTime = (markerIndexOrTime, type) => {
	if (!player.src) {
		alert("Please load a video first.");
		return;
	}
	window.currentLoopCount = 0;
	window.activeLoopMarkerId = null;
	let time;
	if (type === undefined) {
		time = Number.parseFloat(markerIndexOrTime);
	} else {
		const marker = markers[markerIndexOrTime];
		if (!marker) return;
		time = type === "start" ? marker.startTime : marker.endTime;
	}
	if (time !== undefined && time !== null) {
		player.currentTime = time;
		void player
			.play()
			?.catch((err) =>
				console.warn("[Playback] play() blocked or unsupported:", err),
			);
		toConsole("Playing from marker time", time, debuggin);
	}
};

/** Updates the start time of the specified marker to the current playhead. */
const syncMarkerToPlayhead = (markerIndex) => {
	if (!player.src) {
		alert("Please load a video first.");
		return;
	}
	const time = player.currentTime;
	markers[markerIndex].startTime = time;
	markers.sort((a, b) => a.startTime - b.startTime);
	if (typeof syncClipBoundsFromMarkers === "function") {
		syncClipBoundsFromMarkers(activeQueueIndex);
	}
	saveLocalState();
	updateMarkersList();
	if (typeof updateSliderTicks === "function") updateSliderTicks();
	if (typeof scheduleJoinTimelineRebuild === "function") {
		scheduleJoinTimelineRebuild();
	}
};

// Expose marker/table helpers for classic scripts (ui-components.js is not a module)
window.jumpToMarkerTime = jumpToMarkerTime;
window.playFromMarkerTime = playFromMarkerTime;
window.syncMarkerToPlayhead = syncMarkerToPlayhead;
window.deleteMarker = deleteMarker;
window.updateMarkerType = updateMarkerType;
window.updateMarkerName = updateMarkerName;
window.addMarker = addMarker;
window.updateSliderTicks = updateSliderTicks;
window.toggleSettings = toggleSettings;

/** Parses the FFmpeg log output to extract timestamp and update progress. */
export function parseFFmpegTime(line, totalSeconds, progressBar) {
	if (!line) return;
	const match = line.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
	if (match) {
		const hours = Number.parseInt(match[1], 10);
		const minutes = Number.parseInt(match[2], 10);
		const seconds = Number.parseFloat(match[3]);
		const currentSeconds = hours * 3600 + minutes * 60 + seconds;
		if (totalSeconds > 0 && progressBar) {
			const pct = Math.floor((currentSeconds / totalSeconds) * 100);
			progressBar.value = Math.min(100, Math.max(0, pct));
		}
	}
}

/** Binds events and logic for video trimming modal and batch export. */
// Video Trimming & Compression Feature
const initializeTrimFeature = () => {
	const isTauri = window.__TAURI__ !== undefined;
	if (!isTauri) return;

	const trimVideoBtn = document.getElementById("trimVideoBtn");
	const cancelTrimBtn = document.getElementById("cancelTrimBtn");
	const trimOnlyBtn = document.getElementById("trimOnlyBtn");
	const trimCompressBtn = document.getElementById("trimCompressBtn");

	if (trimVideoBtn) {
		trimVideoBtn.classList.remove("hidden");
		trimVideoBtn.addEventListener("click", () => {
			if (!player?.src) {
				alert("Please load a video first.");
				return;
			}
			document.getElementById("trimStartInput").value =
				formatTimeToHHMMSSMS(clipInTime);
			document.getElementById("trimEndInput").value = formatTimeToHHMMSSMS(
				clipOutTime || player.duration,
			);
			resetTrimModalUI();
			// Batch is on by default — refresh join-group job list
			if (typeof window.renderBatchExportList === "function") {
				window.renderBatchExportList();
			}
			toggleSettings(true);
		});
	}

	const resetTrimModalUI = () => {
		if (trimOnlyBtn) trimOnlyBtn.disabled = false;
		if (trimCompressBtn) trimCompressBtn.disabled = false;
		if (cancelTrimBtn) {
			cancelTrimBtn.disabled = false;
			cancelTrimBtn.className = "btn btn-outline-secondary";
			cancelTrimBtn.textContent = "Cancel";
		}
		document.getElementById("trimProgressContainer").classList.add("hidden");
		const spinner = document.getElementById("trimProgressSpinner");
		if (spinner) spinner.classList.add("hidden");

		const batchExportToggle = document.getElementById("batchExportToggle");
		const batchExportList = document.getElementById("batch-export-list");
		const batchStripAudio = document.getElementById("batchStripAudioToggle");
		// Batch export is the default path for the trim/export panel
		if (batchExportToggle) batchExportToggle.checked = true;
		if (batchStripAudio) batchStripAudio.checked = false;
		if (batchExportList) {
			batchExportList.classList.remove("hidden");
			// Job list filled when initializeTrimFeature's renderBatchExportList is available
			if (typeof window.renderBatchExportList === "function") {
				window.renderBatchExportList();
			}
		}

		if (trimOnlyBtn) trimOnlyBtn.style.display = "inline-flex";
		if (trimCompressBtn) trimCompressBtn.style.display = "inline-flex";
		const joinBtn = document.getElementById("joinAndCompressBtn");
		if (joinBtn) joinBtn.style.display = "none";

		if (typeof window.cleanupTetris === "function") {
			window.cleanupTetris();
		}
		const tetrisCont = document.getElementById("tetrisContainer");
		if (tetrisCont) {
			tetrisCont.style.display = "none";
			tetrisCont.classList.add("hidden");
		}
		const normalContent = document.getElementById("trimNormalContent");
		if (normalContent) normalContent.classList.remove("hidden");
		const normalFooter = document.getElementById("trimNormalFooter");
		if (normalFooter) normalFooter.classList.remove("hidden");
	};
	window.resetTrimModalUI = resetTrimModalUI;

	const batchExportToggle = document.getElementById("batchExportToggle");
	const batchExportList = document.getElementById("batch-export-list");
	if (batchExportToggle) {
		batchExportToggle.addEventListener("change", () => {
			if (batchExportToggle.checked) {
				batchExportList.classList.remove("hidden");
				renderBatchExportList();
			} else {
				batchExportList.classList.add("hidden");
			}
		});
	}

	const renderBatchExportList = () => {
		if (!batchExportList) return;
		const jobs = buildBatchJobsFromQueue();
		batchExportList.innerHTML = `
      <div class="flex items-center justify-between mb-2 px-1">
        <span class="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">Export jobs (from join groups)</span>
        <span class="text-[10px] text-zinc-500 dark:text-zinc-400">${jobs.length} output${jobs.length === 1 ? "" : "s"}</span>
      </div>
    `;

		if (jobs.length === 0) {
			const empty = document.createElement("p");
			empty.className = "text-xs text-zinc-500 dark:text-zinc-400 px-1";
			empty.textContent = "Queue is empty or has no media paths.";
			batchExportList.appendChild(empty);
			return;
		}

		jobs.forEach((job, jobIndex) => {
			const row = document.createElement("div");
			row.className =
				"flex items-center justify-between gap-3 p-2 mb-1.5 bg-zinc-50 dark:bg-zinc-800/40 rounded border border-zinc-200 dark:border-zinc-700 text-xs sm:text-sm";
			row.dataset.jobId = job.id;
			const safeLabel = escapeHTML(job.label);
			const badge = job.multi
				? `<span class="flex-shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">Join</span>`
				: `<span class="flex-shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300">Solo</span>`;
			row.innerHTML = `
        <div class="flex items-center gap-2 flex-1 min-w-0">
          ${badge}
          <span class="font-medium truncate dark:text-zinc-300" title="${safeLabel}">${safeLabel}</span>
        </div>
        <div class="flex items-center gap-3 w-40 justify-end">
          <progress id="batch-progress-${jobIndex}" value="0" max="100" class="w-24 h-1.5 rounded overflow-hidden bg-zinc-200 dark:bg-zinc-700 accent-blue-600"></progress>
          <div id="batch-status-${jobIndex}" class="w-5 h-5 flex items-center justify-center text-zinc-400">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle></svg>
          </div>
        </div>
      `;
			batchExportList.appendChild(row);
		});

		// Keep legacy join button hidden (join groups drive batch exports now)
		const joinBtn = document.getElementById("joinAndCompressBtn");
		if (joinBtn) joinBtn.style.display = "none";
		if (trimOnlyBtn) trimOnlyBtn.style.display = "inline-flex";
		if (trimCompressBtn) trimCompressBtn.style.display = "inline-flex";
	};
	window.renderBatchExportList = renderBatchExportList;

	// Default-checked: show job list on first paint
	if (batchExportToggle?.checked && batchExportList) {
		batchExportList.classList.remove("hidden");
		renderBatchExportList();
	}

	const handleCancelClick = async () => {
		if (activeFFmpegChild) {
			isAborted = true;
			toConsole(
				"User clicked cancel: Aborting FFmpeg process...",
				null,
				debuggin,
			);
			try {
				await activeFFmpegChild.kill();
				showToast("Processing aborted by user.", "warning");
			} catch (e) {
				toConsole("Error killing FFmpeg process", e, debuggin);
			}
			activeFFmpegChild = null;
		}
		toggleSettings(false);
		resetTrimModalUI();
	};

	const closeTrim = () => {
		const tetrisCont = document.getElementById("tetrisContainer");
		if (window.isSecretGame) {
			window.isSecretGame = false;
			handleCancelClick();
		} else if (
			tetrisCont &&
			!tetrisCont.classList.contains("hidden") &&
			tetrisCont.style.display !== "none"
		) {
			toConsole(
				"X clicked in Tetris mode, returning to progress screen",
				null,
				debuggin,
			);
			if (typeof window.showNormalProgressScreen === "function") {
				window.showNormalProgressScreen();
			}
		} else {
			handleCancelClick();
		}
	};

	if (cancelTrimBtn) cancelTrimBtn.addEventListener("click", closeTrim);

	if (trimOnlyBtn) {
		trimOnlyBtn.addEventListener("click", () => executeExport("copy"));
	}
	if (trimCompressBtn) {
		trimCompressBtn.addEventListener("click", () => {
			const preset = document.querySelector(
				'input[name="trimQuality"]:checked',
			).value;
			executeExport(preset);
		});
	}
};

/**
 * Walk the playlist queue in order and build export jobs from join groups.
 * - Contiguous joinedToNext run → one concat job
 * - Unjoined item → solo trim job
 * @returns {Array<{ id: string, label: string, indices: number[], segments: Array<{path:string,start_time:number,end_time:number,loop_count:number}>, fileName: string }>}
 */
const buildBatchJobsFromQueue = () => {
	const jobs = [];
	if (typeof videoQueue === "undefined" || !videoQueue.length) return jobs;

	// Ensure clip bounds reflect in/out markers before export
	for (let i = 0; i < videoQueue.length; i++) {
		if (typeof syncClipBoundsFromMarkers === "function") {
			syncClipBoundsFromMarkers(i);
		}
	}

	let i = 0;
	let jobNum = 0;
	while (i < videoQueue.length) {
		const start = i;
		// Grow while this item joins to the next
		while (i < videoQueue.length - 1 && videoQueue[i]?.joinedToNext) {
			i += 1;
		}
		const end = i;
		const indices = [];
		for (let j = start; j <= end; j++) indices.push(j);

		const segs = [];
		const names = [];
		for (const idx of indices) {
			const v = videoQueue[idx];
			if (!v?.videoFilePath) continue;
			const path = v.videoFilePath;
			const startT =
				typeof getClipInTime === "function"
					? getClipInTime(v)
					: Number(v.clipInTime) || 0;
			let endT =
				typeof getClipOutTime === "function"
					? getClipOutTime(v, idx)
					: Number(v.clipOutTime) || 0;
			// Fallback: markers or 0 (backend probes full duration)
			if (endT <= 0) {
				const marks = v.appState?.markers || [];
				const outM = marks.find((m) => m.type === "out" || m.type === "end");
				if (outM) endT = outM.startTime;
			}
			const loopM = (v.appState?.markers || []).find((m) => m.type === "loop");
			const fades =
				typeof getVideoFadeSeconds === "function"
					? getVideoFadeSeconds(v, idx)
					: {
							fadeInSec: Number(v.fadeInSec) || 0,
							fadeOutSec: Number(v.fadeOutSec) || 0,
						};
			const marks = v.appState?.markers || [];
			const speedRanges =
				typeof buildSpeedRanges === "function"
					? buildSpeedRanges(marks, startT, endT > startT ? endT : startT + 1)
					: [{ start: startT, end: endT, rate: 1 }];
			segs.push({
				path,
				start_time: startT,
				end_time: endT,
				loop_count: loopM ? loopM.loopCount || 1 : 1,
				queueIndex: idx,
				fade_in_sec: fades.fadeInSec,
				fade_out_sec: fades.fadeOutSec,
				speed_ranges: speedRanges.map((r) => ({
					start: r.start,
					end: r.end,
					rate: r.rate,
				})),
			});
			const base = (
				v.videoFileName ||
				v.videoName ||
				`clip_${idx + 1}`
			).replace(/\.[^/.]+$/, "");
			names.push(base);
		}

		if (segs.length === 0) {
			i += 1;
			continue;
		}

		jobNum += 1;
		const multi = segs.length > 1;
		let fileName;
		if (multi) {
			const first = names[0] || "clip";
			const last = names[names.length - 1] || "clip";
			const short =
				first === last
					? first
					: `${first.slice(0, 24)}_to_${last.slice(0, 24)}`;
			fileName = `sequence_${String(jobNum).padStart(3, "0")}_${short}.mp4`;
		} else {
			fileName = `${names[0] || `video_${jobNum}`}_export.mp4`;
		}
		// Sanitize filename
		fileName = fileName.replace(/[<>:"/\\|?*]/g, "_");

		const label = multi
			? `Join ${indices.map((n) => n + 1).join("–")}: ${names.join(" + ")}`
			: `${indices[0] + 1}. ${names[0]}`;

		jobs.push({
			id: `job_${jobNum}`,
			label,
			indices,
			segments: segs,
			fileName,
			multi,
		});
		i += 1;
	}
	return jobs;
};
window.buildBatchJobsFromQueue = buildBatchJobsFromQueue;

/** Calculates contiguous logical segments to retain based on marker states. */
const getExportSegments = (markersList, videoDuration) => {
	const sortedMarkers = [...markersList].sort(
		(a, b) => a.startTime - b.startTime,
	);

	let inTime = 0;
	let outTime = videoDuration || 0;

	const inMarker = sortedMarkers.find((m) => m.type === "in");
	if (inMarker) {
		inTime = inMarker.startTime;
	}

	const outMarker = sortedMarkers.find((m) => m.type === "out");
	if (outMarker) {
		outTime = outMarker.startTime;
	}

	const segmentsToKeep = [];
	let keeping = true;
	let currentStart = inTime;

	for (let i = 0; i < sortedMarkers.length; i += 1) {
		const marker = sortedMarkers[i];
		if (marker.startTime <= inTime || marker.startTime >= outTime) {
			continue;
		}

		if (marker.type === "loop") {
			if (keeping && marker.startTime > currentStart) {
				segmentsToKeep.push({
					start: currentStart,
					end: marker.startTime,
					loopCount: 1,
				});
			}
			const nextMarker = sortedMarkers
				.slice(i + 1)
				.find((m) => m.startTime > marker.startTime && m.startTime < outTime);
			const boundaryTime = nextMarker ? nextMarker.startTime : outTime;

			segmentsToKeep.push({
				start: marker.startTime,
				end: boundaryTime,
				loopCount: marker.loopCount !== undefined ? marker.loopCount : 1,
			});

			keeping = true;
			currentStart = boundaryTime;
		} else if (keeping && marker.type === "jump") {
			if (marker.startTime > currentStart) {
				segmentsToKeep.push({
					start: currentStart,
					end: marker.startTime,
					loopCount: 1,
				});
			}
			keeping = false;
		} else if (!keeping && marker.type !== "jump") {
			keeping = true;
			currentStart = marker.startTime;
		}
	}

	if (keeping && outTime > currentStart) {
		segmentsToKeep.push({ start: currentStart, end: outTime, loopCount: 1 });
	}

	return segmentsToKeep;
};

/**
 * Batch-export the playlist as join groups:
 * each contiguous joinedToNext run → one concat; each unjoined item → solo trim.
 */
async function processBatchQueue(presetType) {
	const isTauri = window.__TAURI__ !== undefined;
	if (!isTauri) {
		alert("Tauri desktop API is required for batch exporting.");
		return;
	}

	const jobs = buildBatchJobsFromQueue();
	if (jobs.length === 0) {
		showToast("Queue is empty — nothing to export.", "error");
		return;
	}

	const openDialog = window.__TAURI__ ? window.__TAURI__.dialog.open : null;
	if (!openDialog) {
		alert("Tauri dialog API not available.");
		return;
	}
	const targetDir = await openDialog({
		directory: true,
		multiple: false,
		title: "Select Output Folder for Batch Export",
	});
	if (!targetDir) {
		console.log("Batch cancelled.");
		return;
	}

	const actualOutputDir =
		typeof targetDir === "object" ? targetDir.path : targetDir;

	const stripAudioEl = document.getElementById("batchStripAudioToggle");
	const stripAudio = !!(stripAudioEl && stripAudioEl.checked);
	const quality =
		presetType === "copy" || !presetType ? "copy" : String(presetType);

	const trimOnlyBtn = document.getElementById("trimOnlyBtn");
	const trimCompressBtn = document.getElementById("trimCompressBtn");
	const cancelTrimBtn = document.getElementById("cancelTrimBtn");

	if (trimOnlyBtn) trimOnlyBtn.disabled = true;
	if (trimCompressBtn) trimCompressBtn.disabled = true;
	if (cancelTrimBtn) {
		cancelTrimBtn.disabled = false;
		cancelTrimBtn.className = "btn btn-danger";
		cancelTrimBtn.textContent = "Abort Batch";
	}

	// Refresh job list UI (progress rows)
	const batchExportList = document.getElementById("batch-export-list");
	if (batchExportList && typeof renderBatchExportList === "function") {
		// render is scoped inside initializeTrimFeature — rebuild rows inline
		// by re-checking toggle path; list was already rendered when toggle on.
	}

	isAborted = false;
	let okCount = 0;
	let failCount = 0;

	showToast(
		`Batch export: ${jobs.length} job${jobs.length === 1 ? "" : "s"}${stripAudio ? " (video only)" : ""}…`,
		"info",
	);

	const progressContainer = document.getElementById("trimProgressContainer");
	const progressBar = document.getElementById("trimProgressBar");
	const progressText = document.getElementById("trimProgressText");
	const progressSpinner = document.getElementById("trimProgressSpinner");
	if (progressContainer) progressContainer.classList.remove("hidden");
	if (progressSpinner) progressSpinner.classList.remove("hidden");

	try {
		for (let jobIndex = 0; jobIndex < jobs.length; jobIndex++) {
			if (isAborted) break;
			const job = jobs[jobIndex];

			const statusIconContainer = document.getElementById(
				`batch-status-${jobIndex}`,
			);
			const specificProgressBar = document.getElementById(
				`batch-progress-${jobIndex}`,
			);
			const rowContainer = statusIconContainer?.closest(
				"[data-job-id], .flex.items-center.justify-between",
			);

			if (rowContainer) {
				rowContainer.classList.add("border-blue-500", "bg-blue-50/10");
			}
			if (statusIconContainer) {
				statusIconContainer.innerHTML = `
          <svg class="animate-spin h-4 w-4 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        `;
			}
			if (specificProgressBar) specificProgressBar.value = 10;

			const pctOverall = Math.round((jobIndex / jobs.length) * 100);
			if (progressBar) progressBar.style.width = `${pctOverall}%`;
			if (progressText) {
				progressText.textContent = `${jobIndex + 1}/${jobs.length}`;
			}

			let actualOutputPath = job.fileName;
			try {
				if (joinPathFn) {
					actualOutputPath = await joinPathFn(actualOutputDir, job.fileName);
				} else {
					actualOutputPath = `${actualOutputDir}\\${job.fileName}`;
				}

				// Skip job if any source path missing (continue batch)
				const missing = job.segments.filter((s) => !s.path);
				if (missing.length || job.segments.length === 0) {
					throw new Error("Missing source path for one or more clips.");
				}

				toConsole(
					"Batch export job",
					{ job: job.label, path: actualOutputPath, quality, stripAudio },
					debuggin,
				);

				if (specificProgressBar) specificProgressBar.value = 35;

				// Flat segments: one key per Rust VideoSegment field (no loop_count + loopCount).
				const videoSegments = job.segments.map((s) => ({
					path: s.path,
					start_time: Number(s.start_time) || 0,
					end_time: Number(s.end_time) || 0,
					// Serde field is loop_count; alias loopCount — send only one
					loop_count: Math.max(1, Number(s.loop_count) || 1),
					// Soft export fades only (no burn-in); 0 omitted as 0.0
					fade_in_sec: Math.max(0, Number(s.fade_in_sec) || 0),
					fade_out_sec: Math.max(0, Number(s.fade_out_sec) || 0),
					// Speed marker ranges (source time → setpts/atempo)
					speed_ranges: Array.isArray(s.speed_ranges)
						? s.speed_ranges.map((r) => ({
								start: Number(r.start) || 0,
								end: Number(r.end) || 0,
								rate: clampSpeedValue(r.rate ?? 1),
							}))
						: [{ start: Number(s.start_time) || 0, end: Number(s.end_time) || 0, rate: 1 }],
				}));
				if (window.TM_DEBUG_MODE || debuggin) {
					console.log("[export_queue_job] segments", {
						job: job.label,
						count: videoSegments.length,
						bounds: videoSegments.map((s) => ({
							start: s.start_time,
							end: s.end_time,
							loop: s.loop_count,
						})),
					});
				}
				await window.__TAURI__.core.invoke("export_queue_job", {
					videoSegments,
					outputPath: actualOutputPath,
					quality,
					stripAudio,
				});

				// Soft-caption sidecar next to the video (never fails the video job)
				try {
					const vttResult = await writeBatchExportSidecarVtt(
						job,
						actualOutputPath,
					);
					if (vttResult?.skipped && vttResult.reason === "no-captions") {
						// No markers / source VTT — silent skip per product rules
					} else if (vttResult?.path) {
						toConsole(
							"Batch VTT sidecar written",
							{ path: vttResult.path, job: job.label },
							debuggin,
						);
					}
				} catch (vttErr) {
					console.warn("[batch VTT] sidecar write failed:", vttErr);
					showToast(
						`Exported video; captions not written for ${job.fileName}`,
						"warning",
					);
				}

				if (specificProgressBar) {
					specificProgressBar.value = 100;
					specificProgressBar.classList.add("opacity-50");
				}
				if (statusIconContainer) {
					statusIconContainer.innerHTML = `
            <svg class="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
          `;
				}
				okCount += 1;
				showToast(`Exported: ${job.fileName}`, "success");
			} catch (fileErr) {
				failCount += 1;
				toConsole("Batch job failed", fileErr, debuggin);
				if (statusIconContainer) {
					statusIconContainer.innerHTML = `
            <svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          `;
				}
				showToast(
					`Failed: ${job.label} — ${fileErr?.message || fileErr}`,
					"error",
				);
			} finally {
				if (rowContainer) {
					rowContainer.classList.remove("border-blue-500", "bg-blue-50/10");
				}
			}
		}

		if (progressBar) progressBar.style.width = "100%";
		if (progressText) progressText.textContent = "100%";

		if (isAborted) {
			showToast("Batch processing aborted.", "warning");
		} else {
			showToast(
				`Batch export done: ${okCount} ok, ${failCount} failed.`,
				failCount ? "warning" : "success",
			);
		}
	} finally {
		if (progressSpinner) progressSpinner.classList.add("hidden");
		resetTrimModalUI();
	}
}

/** Triggers the single-video FFmpeg compression and trim export routine. */
async function executeExport(presetType) {
	const batchExportToggle = document.getElementById("batchExportToggle");
	const batchMode = batchExportToggle ? batchExportToggle.checked : false;

	if (batchMode) {
		await processBatchQueue(presetType);
		return;
	}

	if (!videoFilePath) {
		alert("Please load a video file first.");
		return;
	}

	const trimOnlyBtn = document.getElementById("trimOnlyBtn");
	const trimCompressBtn = document.getElementById("trimCompressBtn");
	const originalTrimOnlyText = trimOnlyBtn
		? trimOnlyBtn.textContent
		: "Trim Only (Copy)";
	const originalTrimCompressText = trimCompressBtn
		? trimCompressBtn.textContent
		: "Trim & Compress";

	if (trimOnlyBtn) {
		trimOnlyBtn.textContent = "Exporting...";
		trimOnlyBtn.disabled = true;
	}
	if (trimCompressBtn) {
		trimCompressBtn.textContent = "Exporting...";
		trimCompressBtn.disabled = true;
	}

	isAborted = false;
	let watchdogTimer = null;
	let unlistenStderr = null;
	let tempFilePath = null;
	const stderrLogs = [];

	try {
		const segments = getExportSegments(
			markers,
			player?.duration ? player.duration : 0,
		);
		if (segments.length === 0) {
			throw new Error("No segments to export.");
		}

		const defaultPath = `trimmed_${videoFileName || "video.mp4"}`;
		toConsole("Opening Tauri save dialog...", { defaultPath }, debuggin);

		let outputPath;
		try {
			outputPath = await window.__TAURI__?.dialog?.save?.({
				filters: [{ name: "Video", extensions: ["mp4", "webm", "mov", "avi"] }],
				defaultPath: defaultPath,
			});
		} catch (err) {
			toConsole("Tauri save dialog error", err, debuggin);
			throw err;
		}

		if (!outputPath) {
			toConsole("Tauri save dialog cancelled by user", null, debuggin);
			throw new Error("Save location was not specified.");
		}

		const actualOutputPath =
			typeof outputPath === "object" ? outputPath.path : outputPath;
		toConsole("Save path selected", actualOutputPath, debuggin);

		if (
			videoFilePath &&
			actualOutputPath &&
			videoFilePath.toLowerCase() === actualOutputPath.toLowerCase()
		) {
			toConsole(
				"executeExport abort: Input and output paths are identical",
				actualOutputPath,
				debuggin,
			);
			throw new Error("Input and output paths are identical.");
		}

		// Speed markers (and fades) go through export_queue_job so setpts/atempo + fades apply.
		// Note: jump-skip demuxer path below does not apply Speed; prefer Speed on continuous clip.
		const hasSpeedMarkers = (markers || []).some((m) => m?.type === "speed");
		const activeVid =
			typeof videoQueue !== "undefined" ? videoQueue[activeQueueIndex] : null;
		const fadesSolo =
			typeof getVideoFadeSeconds === "function"
				? getVideoFadeSeconds(activeVid, activeQueueIndex)
				: {
						fadeInSec: Number(activeVid?.fadeInSec) || 0,
						fadeOutSec: Number(activeVid?.fadeOutSec) || 0,
					};
		if (
			hasSpeedMarkers ||
			fadesSolo.fadeInSec > 0 ||
			fadesSolo.fadeOutSec > 0
		) {
			const inT =
				typeof getClipInTime === "function"
					? getClipInTime(activeVid)
					: Number(clipInTime) || 0;
			let outT =
				typeof getClipOutTime === "function"
					? getClipOutTime(activeVid, activeQueueIndex)
					: Number(clipOutTime) || 0;
			if (outT <= inT && player?.duration) outT = player.duration;
			const speedRanges = buildSpeedRanges(markers || [], inT, outT);
			const quality =
				presetType === "copy" || !presetType ? "copy" : String(presetType);
			await window.__TAURI__.core.invoke("export_queue_job", {
				videoSegments: [
					{
						path: videoFilePath,
						start_time: inT,
						end_time: outT,
						loop_count: 1,
						fade_in_sec: fadesSolo.fadeInSec,
						fade_out_sec: fadesSolo.fadeOutSec,
						speed_ranges: speedRanges.map((r) => ({
							start: r.start,
							end: r.end,
							rate: r.rate,
						})),
					},
				],
				outputPath: actualOutputPath,
				quality,
				stripAudio: false,
			});
			showToast(`Exported: ${actualOutputPath.split(/[/\\]/).pop()}`, "success");
			return;
		}

		// Map input video path to use forward slashes (FFmpeg concat demuxer preference)
		const safePath = videoFilePath.replace(/\\/g, "/");

		// Build the demuxer list string
		let listContent = "";
		for (const seg of segments) {
			const loopCount = seg.loopCount || 1;
			for (let l = 0; l < loopCount; l++) {
				listContent += `file '${safePath}'\n`;
				listContent += `inpoint ${seg.start}\n`;
				listContent += `outpoint ${seg.end}\n`;
			}
		}

		// Write the list file under $TEMP (fs scope always allows it)
		tempFilePath = await resolveFfmpegConcatListPath(
			"ffmpeg_concat_list.txt",
			actualOutputPath,
		);
		await writeTextFile(tempFilePath, listContent);

		// Clip-edge fades on the active source (export timeline t=0 / end)
		const activeFades =
			typeof getVideoFadeSeconds === "function"
				? getVideoFadeSeconds(
						typeof videoQueue !== "undefined"
							? videoQueue[activeQueueIndex]
							: null,
						activeQueueIndex,
					)
				: { fadeInSec: 0, fadeOutSec: 0 };
		const fadeInSec = activeFades.fadeInSec || 0;
		const fadeOutSec = activeFades.fadeOutSec || 0;
		const hasFades = fadeInSec > 0 || fadeOutSec > 0;

		const duration = segments.reduce(
			(sum, seg) => sum + (seg.end - seg.start) * (seg.loopCount || 1),
			0,
		);

		// Build FFmpeg args — fades force reencode (cannot stream-copy through fade filters)
		const isCompression = presetType !== "copy" || hasFades;
		const args = [
			"-y",
			"-nostdin",
			"-nostats",
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			tempFilePath,
			"-progress",
			"pipe:2",
		];

		if (!isCompression) {
			args.push("-c", "copy");
		} else {
			const inputHeight = player.videoHeight || 0;
			let targetHeight = 1080;
			if (presetType === "low") {
				targetHeight = 720;
			}
			if (inputHeight > 0 && inputHeight < targetHeight) {
				targetHeight = inputHeight;
			}

			const vfParts = [];
			// Copy quality with fades only: no scale; compress presets keep scale
			if (presetType !== "copy") {
				vfParts.push(`scale=-2:${targetHeight}`);
			}
			if (fadeInSec > 0) {
				const d = Math.min(fadeInSec, Math.max(0.01, duration));
				vfParts.push(`fade=t=in:st=0:d=${d.toFixed(4)}`);
			}
			if (fadeOutSec > 0) {
				const d = Math.min(fadeOutSec, Math.max(0.01, duration));
				// Reach solid black slightly before the cut (frame rounding otherwise
				// leaves the last frame mid-grey). Black holds through the remaining samples.
				const early = Math.min(0.08, d * 0.2, Math.max(0, duration * 0.5));
				const st = Math.max(0, duration - d - early);
				vfParts.push(
					`fade=t=out:st=${st.toFixed(4)}:d=${d.toFixed(4)}:color=black`,
				);
			}

			let crf = "26";
			let preset = "fast";
			if (presetType === "low") {
				crf = "32";
				preset = "veryfast";
			} else if (presetType === "high") {
				crf = "18";
				preset = "medium";
			} else if (presetType === "copy" && hasFades) {
				// Light reencode just for soft fade filters
				crf = "18";
				preset = "fast";
			}

			if (vfParts.length) {
				args.push("-vf", vfParts.join(","));
			}
			args.push(
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-crf",
				crf,
				"-preset",
				preset,
				"-threads",
				"4",
			);

			const afParts = [];
			if (fadeInSec > 0) {
				const d = Math.min(fadeInSec, Math.max(0.01, duration));
				afParts.push(`afade=t=in:st=0:d=${d.toFixed(4)}`);
			}
			if (fadeOutSec > 0) {
				const d = Math.min(fadeOutSec, Math.max(0.01, duration));
				const early = Math.min(0.08, d * 0.2, Math.max(0, duration * 0.5));
				const st = Math.max(0, duration - d - early);
				afParts.push(`afade=t=out:st=${st.toFixed(4)}:d=${d.toFixed(4)}`);
			}
			if (afParts.length) {
				args.push("-af", afParts.join(","), "-c:a", "aac", "-b:a", "128k");
			} else {
				args.push("-c:a", "copy");
			}
			args.push("-max_muxing_queue_size", "4096");
		}

		args.push(actualOutputPath);
		toConsole("Spawning FFmpeg with args", args, debuggin);

		const progressContainer = document.getElementById("trimProgressContainer");
		const progressBar = document.getElementById("trimProgressBar");
		const progressText = document.getElementById("trimProgressText");
		const spinner = document.getElementById("trimProgressSpinner");

		progressContainer.classList.remove("hidden");
		if (spinner) spinner.classList.remove("hidden");
		progressBar.style.width = "0%";
		progressText.textContent = "0%";

		let lastPct = -1;

		const WATCHDOG_MS = 30_000;
		const resetWatchdog = () => {
			clearTimeout(watchdogTimer);
			watchdogTimer = setTimeout(async () => {
				toConsole(
					"FFmpeg watchdog: no progress for 30s — aborting",
					null,
					debuggin,
				);
				isAborted = true;
				try {
					await window.__TAURI__?.core?.invoke?.("abort_ffmpeg");
					toConsole("FFmpeg watchdog kill: success", null, debuggin);
				} catch (killErr) {
					toConsole("FFmpeg watchdog kill: failed", killErr, debuggin);
				}
			}, WATCHDOG_MS);
		};

		resetWatchdog();

		activeFFmpegChild = {
			kill: async () => {
				try {
					await window.__TAURI__?.core?.invoke?.("abort_ffmpeg");
				} catch (e) {
					toConsole("Error aborting ffmpeg via invoke", e, debuggin);
				}
			},
		};

		unlistenStderr = await window.__TAURI__?.event?.listen?.(
			"ffmpeg-stderr",
			(event) => {
				const line = event.payload || "";
				const isProgressSpam =
					line.includes("=") &&
					(line.startsWith("frame=") ||
						line.startsWith("fps=") ||
						line.startsWith("stream_") ||
						line.startsWith("bitrate=") ||
						line.startsWith("total_size=") ||
						line.startsWith("out_time") ||
						line.startsWith("dup_frames=") ||
						line.startsWith("drop_frames=") ||
						line.startsWith("speed=") ||
						line.startsWith("progress="));
				if (!isProgressSpam) {
					toConsole("FFmpeg stderr raw output", line, debuggin);
				}

				stderrLogs.push(line);
				if (stderrLogs.length > 50) {
					stderrLogs.shift();
				}

				const match = line.match(/out_time_us=(\d+)/);
				if (match) {
					resetWatchdog();
					const val = Number.parseInt(match[1], 10);
					const currentSeconds = val / 1_000_000;
					if (duration > 0) {
						const pct = Math.min(
							100,
							Math.max(0, Math.round((currentSeconds / duration) * 100)),
						);
						if (pct !== lastPct) {
							lastPct = pct;
							toConsole(
								"FFmpeg progress percentage updated",
								{ pct, currentSeconds, duration },
								debuggin,
							);
							progressBar.style.width = `${pct}%`;
							progressText.textContent = `${pct}%`;
							if (typeof window.updateTetrisProgress === "function") {
								window.updateTetrisProgress(pct);
							}
						}
					}
				}
			},
		);

		toConsole(
			"Spawning FFmpeg sidecar process via Rust backend...",
			null,
			debuggin,
		);
		try {
			await window.__TAURI__?.core?.invoke?.("run_ffmpeg", { args });
		} finally {
			if (tempFilePath && remove) {
				try {
					const fileExists = exists ? await exists(tempFilePath) : true;
					if (fileExists) {
						await remove(tempFilePath);
					}
				} catch (e) {
					console.warn("Failed to delete temp file:", e);
				}
			}
		}

		progressBar.style.width = "100%";
		progressText.textContent = "100%";

		if (spinner) spinner.classList.add("hidden");

		// Remap remaining bookmark/marker timestamps to account for physically removed segments
		const remapTime = (t, segs) => {
			let newTime = 0;
			for (let i = 0; i < segs.length; i++) {
				const seg = segs[i];
				if (t < seg.start) {
					return newTime;
				}
				if (t >= seg.start && t <= seg.end) {
					return newTime + (t - seg.start);
				}
				newTime += seg.end - seg.start;
			}
			return newTime;
		};

		const updatedMarkers = [];
		for (let i = 0; i < markers.length; i += 1) {
			const marker = markers[i];
			if (marker.type === "jump") {
				continue;
			}
			marker.startTime = remapTime(marker.startTime, segments);
			if (marker.endTime) {
				marker.endTime = remapTime(marker.endTime, segments);
			}
			updatedMarkers.push(marker);
		}
		markers.length = 0;
		markers.push(...updatedMarkers);

		clipInTime = 0;
		clipOutTime = duration;

		videoFilePath = actualOutputPath;
		videoFileName = actualOutputPath.replace(/^.*[\\/]/, "");

		// Intentional exception: FFmpeg export output is already H.264/copy (playback-safe).
		// Still prefer loadVideo so any future re-encode paths stay consistent.
		if (typeof window.loadVideo === "function") {
			await window.loadVideo(videoFilePath);
		} else {
			const tauriAssetUrl =
				window.__TAURI__?.core?.convertFileSrc?.(videoFilePath);
			player.src = tauriAssetUrl;
			player.preload = "auto";
			player.load();
			toggleVideoPlaceholder(false);
			window.loadSubtitleTrack(videoFilePath);
		}

		saveLocalState();
		updateMarkersList();

		const tetrisCont = document.getElementById("tetrisContainer");
		if (
			typeof window.onVideoProcessingFinished === "function" &&
			tetrisCont &&
			!tetrisCont.classList.contains("hidden")
		) {
			showToast("Video completed.", "success");
			window.onVideoProcessingFinished();
		} else {
			toggleSettings(false);
			if (typeof window.resetTrimModalUI === "function") {
				window.resetTrimModalUI();
			}

			showToast("Video completed.", "success");

			const saveConfirm = await asyncConfirm(
				"Timestamps shifted. Save project changes now?",
				"Save Project",
			);
			if (saveConfirm) {
				await exportToJSON(false);
			}
		}
	} catch (err) {
		toConsole("FFmpeg process failed or aborted", err, debuggin);
		if (isAborted) {
			alert("Export aborted by user.");
		} else {
			const fullErrLogs = stderrLogs ? stderrLogs.join("\n") : "";
			alert(
				`Export failed: ${err.message || err}\n\nFFmpeg Logs:\n${fullErrLogs || "(no stderr output)"}`,
			);
		}
	} finally {
		clearTimeout(watchdogTimer);
		activeFFmpegChild = null;
		if (unlistenStderr) {
			unlistenStderr();
		}
		if (tempFilePath && remove) {
			try {
				const fileExists = exists ? await exists(tempFilePath) : true;
				if (fileExists) {
					await remove(tempFilePath);
				}
			} catch (e) {
				console.warn("Failed to delete temp file:", e);
			}
		}
		if (trimOnlyBtn) {
			trimOnlyBtn.textContent = originalTrimOnlyText;
			trimOnlyBtn.disabled = false;
		}
		if (trimCompressBtn) {
			trimCompressBtn.textContent = originalTrimCompressText;
			trimCompressBtn.disabled = false;
		}
	}
}

// 4. Left Sidebar Playlist Interface Utilities (Populators, Row Re-indexers, Shuffling Loops)
/** Renders the video queue options in the DOM select. */
const renderVideoQueueSelect = () => {
	if (!DOM.videoQueueSelect) return;
	DOM.videoQueueSelect.innerHTML = "";
	for (const [index, video] of videoQueue.entries()) {
		const option = document.createElement("option");
		option.value = index;
		option.textContent = video.videoFileName || "Unknown File";
		option.className =
			"bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white";
		DOM.videoQueueSelect.appendChild(option);
	}
	DOM.videoQueueSelect.selectedIndex = activeQueueIndex;
};

/** Switches the active video to the specified index in the queue. */
const switchVideoInQueue = async (index) => {
	if (index === activeQueueIndex) return;

	resetVideoViewport(player);
	preserveClipBounds = true;
	saveLocalState();

	activeQueueIndex = index;
	const currentVideo = videoQueue[activeQueueIndex];

	videoFileName = currentVideo.videoFileName || "";
	videoFilePath = currentVideo.videoFilePath || "";
	clipInTime = currentVideo.clipInTime || 0;
	clipOutTime = currentVideo.clipOutTime || 0;

	markers = currentVideo.appState?.markers || [];
	for (const m of markers) {
		if (!m.type) m.type = "standard";
	}

	renderVideoQueueSelect();
	updateMarkersList();

	player.pause();
	// Full media replace: clear tracks so previous source captions cannot stick
	if (typeof window.clearSubtitleTracks === "function") {
		window.clearSubtitleTracks();
	}
	const isTauri = window.__TAURI__ !== undefined;

	if (isTauri && videoFilePath) {
		await window.loadVideo(videoFilePath);
	} else if (videoFileName && videoBlobCache[videoFileName]) {
		// Browser blob cache — intentional exception
		player.src = videoBlobCache[videoFileName];
		player.preload = "metadata";
		toggleVideoPlaceholder(false);
		updateLoadButtonColor();
	} else {
		player.src = "";
		player.removeAttribute("src");
		DOM.videoPlaceholder.textContent = videoFileName
			? `Video switched. Click here to locate video: ${videoFileName}`
			: "Load a video to get started";
		toggleVideoPlaceholder(true);
		updateLoadButtonColor();
		if (typeof window.updateProxyInfoUi === "function") {
			window.updateProxyInfoUi(null);
		}
	}

	if (!DOM.settingsPanel.classList.contains("translate-x-full")) {
		toggleSettings(true);
	}

	showToast(`Switched to: ${currentVideo.videoName}`, "success");
	updateSliderTicks();
	// Active join run may change with selection — rebuild sequence timeline
	syncSequenceModeState();
	if (typeof window.refreshSidebarPlaylist === "function") {
		window.refreshSidebarPlaylist();
	} else if (typeof window.renderSidebarPlaylist === "function") {
		window.renderSidebarPlaylist();
	}
	if (typeof window.updateProxyInfoUi === "function") {
		window.updateProxyInfoUi(currentVideo.proxyPath || null);
	}
};

/** Removes the currently active video from the project queue. */
const removeCurrentVideo = async () => {
	if (videoQueue.length === 0) return;

	if (isQueueIndexJoined(activeQueueIndex)) {
		showToast("Unjoin first before removing this queue item.", "error");
		return;
	}

	resetVideoViewport(player);

	const confirmRemove = await asyncConfirm(
		"Are you sure you want to remove this video from the project?",
		"Remove Video",
	);
	if (!confirmRemove) return;

	// Capture removed item for proxy cleanup before splice
	const removed = videoQueue[activeQueueIndex];
	if (typeof window.deleteProxyForQueueItem === "function") {
		await window.deleteProxyForQueueItem(removed);
	}

	// Clear CC immediately for the deleted current video
	if (typeof window.clearSubtitleTracks === "function") {
		window.clearSubtitleTracks();
	}
	if (typeof window.updateProxyInfoUi === "function") {
		window.updateProxyInfoUi(null);
	}

	videoQueue.splice(activeQueueIndex, 1);
	if (videoQueue.length > 0) {
		videoQueue[videoQueue.length - 1].joinedToNext = false;
	}

	if (videoQueue.length === 0) {
		activeQueueIndex = 0;
		videoFileName = "";
		videoFilePath = "";
		clipInTime = 0;
		clipOutTime = 0;
		markers = [];

		player.src = "";
		player.removeAttribute("src");
		toggleVideoPlaceholder(true);
		DOM.videoPlaceholder.textContent = "Load a video to get started";

		renderVideoQueueSelect();
		if (typeof window.refreshSidebarPlaylist === "function") {
			window.refreshSidebarPlaylist();
		}
		updateMarkersList();
		updateSliderTicks();
		saveLocalState();
		showToast("Video removed from queue.", "info");
	} else {
		if (activeQueueIndex >= videoQueue.length) {
			activeQueueIndex = videoQueue.length - 1;
		}

		const currentVideo = videoQueue[activeQueueIndex];
		videoFileName = currentVideo.videoFileName || "";
		videoFilePath = currentVideo.videoFilePath || "";
		clipInTime = currentVideo.clipInTime || 0;
		clipOutTime = currentVideo.clipOutTime || 0;
		markers = currentVideo.appState?.markers || [];
		for (const m of markers) {
			if (!m.type) m.type = "standard";
		}

		renderVideoQueueSelect();
		if (typeof window.refreshSidebarPlaylist === "function") {
			window.refreshSidebarPlaylist();
		}
		updateMarkersList();

		player.pause();
		// Full media replace: clear captions before loading the next source
		if (typeof window.clearSubtitleTracks === "function") {
			window.clearSubtitleTracks();
		}
		const isTauri = window.__TAURI__ !== undefined;
		if (isTauri && videoFilePath) {
			await window.loadVideo(videoFilePath);
		} else if (videoFileName && videoBlobCache[videoFileName]) {
			// Browser blob cache — intentional exception
			player.src = videoBlobCache[videoFileName];
			player.preload = "metadata";
			toggleVideoPlaceholder(false);
			updateLoadButtonColor();
			if (typeof window.updateProxyInfoUi === "function") {
				window.updateProxyInfoUi(currentVideo.proxyPath || null);
			}
		} else {
			player.src = "";
			player.removeAttribute("src");
			DOM.videoPlaceholder.textContent = videoFileName
				? `Video switched. Click here to locate video: ${videoFileName}`
				: "Load a video to get started";
			toggleVideoPlaceholder(true);
			updateLoadButtonColor();
			if (typeof window.updateProxyInfoUi === "function") {
				window.updateProxyInfoUi(null);
			}
		}
		updateSliderTicks();
		saveLocalState();
		showToast(`Switched to: ${currentVideo.videoName}`, "success");
	}
};

window.removeCurrentVideo = removeCurrentVideo;

/** Prompts for a new video name and adds a slot to the queue. */
const addVideoToQueue = async () => {
	const videoName = await asyncPrompt(
		"Enter a name for the new video:",
		`Video ${videoQueue.length + 1}`,
		"New Video",
	);
	if (!videoName) return;
	const duplicate = await asyncConfirm(
		"Would you like to duplicate the current video's data? (Click 'Cancel' to create a blank video slot)",
		"Duplicate Data?",
	);

	saveLocalState();
	const newVideoId =
		videoQueue.length > 0
			? Math.max(...videoQueue.map((v) => v.videoId)) + 1
			: 1;

	const newVideo = duplicate
		? {
				...JSON.parse(JSON.stringify(videoQueue[activeQueueIndex])),
				videoId: newVideoId,
				videoName,
				joinedToNext: false,
			}
		: {
				videoId: newVideoId,
				videoName,
				videoFileName: "",
				videoFilePath: "",
				clipInTime: 0,
				clipOutTime: 0,
				fadeInSec: 0,
				fadeOutSec: 0,
				joinedToNext: false,
				appState: { markers: [] },
			};

	// Previous last item may keep joinedToNext; new last must not join past end
	videoQueue.push(newVideo);
	videoQueue[videoQueue.length - 1].joinedToNext = false;
	if (typeof window.refreshSidebarPlaylist === "function") {
		window.refreshSidebarPlaylist();
	}
	await switchVideoInQueue(videoQueue.length - 1);
	if (typeof window.refreshSidebarPlaylist === "function") {
		window.refreshSidebarPlaylist();
	}
};

async function addNewVideoToQueue(event) {
	if (event) event.preventDefault();

	console.log("[Queue Subsystem] Invoking system native file selector...");

	// 1. Map explicit Tauri v2 dialog plugin endpoints
	const nativeTauriOpenDialog =
		window.__TAURI__?.dialog?.open ||
		(window.__TAURI__?.core?.invoke
			? (options) => window.__TAURI__.core.invoke("plugin:dialog|open", options)
			: null);

	if (!nativeTauriOpenDialog) {
		console.error(
			"[Queue Subsystem] Failed to map Tauri dialog plugin components. Check capability settings.",
		);
		return;
	}

	try {
		// 2. Call the file selector securely using standard Tauri filter options
		const selectedFilePathFile = await nativeTauriOpenDialog({
			multiple: false,
			title: "Select Target Video Asset for Processing Queue",
			filters: [
				{
					name: "Media Containers",
					extensions: ["mp4", "mkv", "avi", "mov", "webm"],
				},
			],
		});

		if (!selectedFilePathFile) {
			console.log(
				"[Queue Subsystem] User cancelled file selection dialog channel block.",
			);
			return;
		}

		// 3. Pass the clean absolute string path token to your queue handler logic downstream
		const filePath =
			typeof selectedFilePathFile === "string"
				? selectedFilePathFile
				: selectedFilePathFile.path;
		console.log(
			"[Queue Subsystem] Enqueuing verified target selection asset path:",
			filePath,
		);

		const extractedFileName = filePath.split(/[/\\]/).pop();

		const newItem = {
			videoId: Date.now(),
			videoName: extractedFileName,
			videoFileName: extractedFileName,
			videoFilePath: filePath,
			clipInTime: 0,
			clipOutTime: 0,
			fadeInSec: 0,
			fadeOutSec: 0,
			joinedToNext: false,
			appState: { markers: [] },
		};

		saveLocalState();
		videoQueue.push(newItem);
		if (videoQueue.length > 1) {
			// New tail cannot be joined forward
			videoQueue[videoQueue.length - 1].joinedToNext = false;
		}

		renderVideoQueueSelect();
		// Always refresh left playlist (open or closed) — do not wait for panel toggle
		if (typeof window.refreshSidebarPlaylist === "function") {
			window.refreshSidebarPlaylist();
		}
		await switchVideoInQueue(videoQueue.length - 1);
		// switchVideoInQueue no-ops when already on the new index; refresh again after load
		if (typeof window.refreshSidebarPlaylist === "function") {
			window.refreshSidebarPlaylist();
		}
	} catch (dialogProcessException) {
		console.error(
			"[Queue Subsystem] Dialog process interaction channel failed:",
			dialogProcessException,
		);
	}
}

/** Renames the current video in the queue based on user input. */
const editVideoInQueue = async () => {
	const currentName = videoQueue[activeQueueIndex].videoName;
	const newName = await asyncPrompt(
		"Rename Video:",
		currentName,
		"Edit Video Name",
	);
	if (!newName || newName.trim() === "") return;

	videoQueue[activeQueueIndex].videoName = newName.trim();
	saveLocalState();
	renderVideoQueueSelect();
	if (typeof window.refreshSidebarPlaylist === "function") {
		window.refreshSidebarPlaylist();
	}
	showToast("Video renamed successfully.", "success");
};

let _sidebarPlaylistElements = [];

/** Drop cached playlist nodes so the next render rebuilds Join chips from state. */
window.invalidateSidebarPlaylistCache = () => {
	_sidebarPlaylistElements = [];
	const container = document.getElementById("sidebar-queue-list");
	if (container) container.innerHTML = "";
};

/**
 * Invalidate cache + re-render left playlist. Call on every queue mutation
 * (add/remove/reorder/join/clear) so the open panel updates without toggle.
 */
window.refreshSidebarPlaylist = () => {
	if (typeof window.invalidateSidebarPlaylistCache === "function") {
		window.invalidateSidebarPlaylistCache();
	}
	if (typeof window.renderSidebarPlaylist === "function") {
		window.renderSidebarPlaylist();
	}
};

/** Update optional Proxy Info UI (settings / debug) for the active item. */
window.updateProxyInfoUi = (proxyPath) => {
	const el = document.getElementById("proxyInfoPath");
	const wrap = document.getElementById("proxyInfoSection");
	if (el) {
		el.textContent = proxyPath || "None";
	}
	if (wrap) {
		wrap.classList.toggle("hidden", !proxyPath);
	}
	window.currentProxyPath = proxyPath || null;
};

/**
 * Delete app-cache proxy for a source path (and clear tracked proxyPath).
 * @param {{ videoFilePath?: string, proxyPath?: string|null }} video
 */
window.deleteProxyForQueueItem = async (video) => {
	if (!video) return;
	const sourcePath = video.videoFilePath || "";
	const trackedProxy = video.proxyPath || null;
	const invokeFn = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
	if (invokeFn && sourcePath) {
		try {
			await invokeFn("delete_proxy_for_video", { videoPath: sourcePath });
		} catch (err) {
			console.warn("[Proxy] delete_proxy_for_video failed:", err);
		}
	}
	// If UI/queue stored an explicit proxy path under cache, try that key too
	if (invokeFn && trackedProxy && trackedProxy !== sourcePath) {
		try {
			await invokeFn("delete_proxy_for_video", { videoPath: trackedProxy });
		} catch {
			/* ignore */
		}
	}
	video.proxyPath = null;
	if (window.currentProxyPath === trackedProxy) {
		window.currentProxyPath = null;
	}
	if (typeof window.updateProxyInfoUi === "function") {
		window.updateProxyInfoUi(null);
	}
};

const JOIN_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

/** Rebuilds the DOM list of videos for the left playlist sidebar using cached nodes and diffing for performance. */
window.renderSidebarPlaylist = () => {
	const container = document.getElementById("sidebar-queue-list");
	if (!container) return;

	const queueLen = videoQueue.length;

	// Ensure last item never claims a next join
	if (queueLen > 0 && videoQueue[queueLen - 1]) {
		videoQueue[queueLen - 1].joinedToNext = false;
	}

	// If the queue size has changed (added, removed, cleared), rebuild the DOM elements
	if (_sidebarPlaylistElements.length !== queueLen) {
		container.innerHTML = "";
		_sidebarPlaylistElements = [];
		const fragment = document.createDocumentFragment();

		for (let index = 0; index < queueLen; index++) {
			const group = document.createElement("div");
			group.className = "queue-item-group";

			const div = document.createElement("div");
			div.className =
				"flex items-center justify-between gap-2 p-2.5 rounded cursor-pointer text-sm transition-colors border select-none";

			const span = document.createElement("span");
			span.className = "truncate flex-1 pointer-events-none";

			// Action wrapper container for reorder buttons
			const actionWrapper = document.createElement("div");
			actionWrapper.className = "flex items-center gap-1.5 flex-shrink-0";

			// Move Up Button
			const moveUpBtn = document.createElement("button");
			moveUpBtn.type = "button";
			moveUpBtn.className =
				"p-1 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer flex items-center justify-center transition-colors";
			moveUpBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
			moveUpBtn.title = "Move up";
			moveUpBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				const idx = parseInt(moveUpBtn.dataset.index, 10);
				if (idx <= 0) return;

				// Swap items
				const temp = videoQueue[idx];
				videoQueue[idx] = videoQueue[idx - 1];
				videoQueue[idx - 1] = temp;

				// Adjust activeQueueIndex
				if (activeQueueIndex === idx) {
					activeQueueIndex = idx - 1;
				} else if (activeQueueIndex === idx - 1) {
					activeQueueIndex = idx;
				}

				// Tail cannot stay joined forward after reorder
				if (videoQueue.length > 0) {
					videoQueue[videoQueue.length - 1].joinedToNext = false;
				}

				saveLocalState();
				renderVideoQueueSelect();
				if (typeof window.refreshSidebarPlaylist === "function") {
					window.refreshSidebarPlaylist();
				} else {
					window.renderSidebarPlaylist();
				}
				scheduleJoinTimelineRebuild();
			});
			actionWrapper.appendChild(moveUpBtn);

			// Move Down Button
			const moveDownBtn = document.createElement("button");
			moveDownBtn.type = "button";
			moveDownBtn.className =
				"p-1 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer flex items-center justify-center transition-colors";
			moveDownBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
			moveDownBtn.title = "Move down";
			moveDownBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				const idx = parseInt(moveDownBtn.dataset.index, 10);
				if (idx >= videoQueue.length - 1) return;

				// Swap items
				const temp = videoQueue[idx];
				videoQueue[idx] = videoQueue[idx + 1];
				videoQueue[idx + 1] = temp;

				// Adjust activeQueueIndex
				if (activeQueueIndex === idx) {
					activeQueueIndex = idx + 1;
				} else if (activeQueueIndex === idx + 1) {
					activeQueueIndex = idx;
				}

				if (videoQueue.length > 0) {
					videoQueue[videoQueue.length - 1].joinedToNext = false;
				}

				saveLocalState();
				renderVideoQueueSelect();
				if (typeof window.refreshSidebarPlaylist === "function") {
					window.refreshSidebarPlaylist();
				} else {
					window.renderSidebarPlaylist();
				}
				scheduleJoinTimelineRebuild();
			});
			actionWrapper.appendChild(moveDownBtn);

			div.appendChild(span);
			div.appendChild(actionWrapper);

			div.addEventListener("click", async () => {
				const idx = parseInt(div.dataset.index, 10);
				await switchVideoInQueue(idx);
				window.renderSidebarPlaylist();
				// Active run may change — rebuild sequence timeline
				scheduleJoinTimelineRebuild();
			});

			group.appendChild(div);

			// Between-row Join control (not on last item)
			let joinBtn = null;
			if (index < queueLen - 1) {
				joinBtn = document.createElement("button");
				joinBtn.type = "button";
				joinBtn.className = "queue-join-control";
				joinBtn.innerHTML = JOIN_ICON_SVG;
				joinBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					const idx = parseInt(joinBtn.dataset.index, 10);
					toggleJoinedToNext(idx);
				});
				group.appendChild(joinBtn);
			}

			_sidebarPlaylistElements.push({
				group,
				div,
				span,
				moveUpBtn,
				moveDownBtn,
				joinBtn,
				lastVideoName: null,
				lastActive: null,
				lastIndex: -1,
				lastJoined: null,
			});

			fragment.appendChild(group);
		}

		container.appendChild(fragment);
	}

	// Update cached nodes conditionally
	for (let index = 0; index < queueLen; index++) {
		const els = _sidebarPlaylistElements[index];
		const video = videoQueue[index];

		const isActive = index === activeQueueIndex;
		const videoName = video.videoFileName || "Unknown File";
		const isJoined = !!video.joinedToNext && index < queueLen - 1;

		const videoChanged = els.lastVideoName !== videoName;
		const activeChanged = els.lastActive !== isActive;
		const indexChanged = els.lastIndex !== index;
		const joinedChanged = els.lastJoined !== isJoined;

		if (!videoChanged && !activeChanged && !indexChanged && !joinedChanged) {
			continue;
		}

		if (videoChanged || activeChanged || indexChanged) {
			const numberPrefix = `${index + 1}. `;
			els.span.textContent = isActive
				? `▶ ${numberPrefix}${videoName}`
				: `${numberPrefix}${videoName}`;
		}

		if (activeChanged) {
			if (isActive) {
				els.div.className =
					"flex items-center justify-between gap-2 p-2.5 rounded cursor-pointer text-sm transition-colors border select-none bg-zinc-200 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-white font-semibold";
			} else {
				els.div.className =
					"flex items-center justify-between gap-2 p-2.5 rounded cursor-pointer text-sm transition-colors border select-none bg-zinc-100 dark:bg-zinc-800/40 border-transparent text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700/60";
			}
		}

		if (indexChanged) {
			els.moveUpBtn.dataset.index = index;
			els.moveDownBtn.dataset.index = index;
			els.div.dataset.index = index;

			els.moveUpBtn.disabled = index === 0;
			els.moveDownBtn.disabled = index === queueLen - 1;
			if (els.joinBtn) {
				els.joinBtn.dataset.index = index;
			}
		}

		if (els.joinBtn && (joinedChanged || indexChanged)) {
			els.joinBtn.dataset.index = index;
			els.joinBtn.classList.toggle("is-joined", isJoined);
			els.joinBtn.title = isJoined ? "Unjoin" : "Join";
			els.joinBtn.setAttribute("aria-label", isJoined ? "Unjoin" : "Join");
			els.joinBtn.setAttribute("aria-pressed", isJoined ? "true" : "false");
		}

		els.lastVideoName = videoName;
		els.lastActive = isActive;
		els.lastIndex = index;
		els.lastJoined = isJoined;
	}

	// Disable load control while the active row is part of a join
	if (typeof updateLoadButtonColor === "function") {
		updateLoadButtonColor();
	}
};

// 5. Central LocalStorage Serialization Triggers

/** Last-cue hold (seconds) when no next marker; clamped to clipOut/duration. */
const VTT_DEFAULT_CUE_HOLD_SEC = 3;

/**
 * Transform raw seconds into valid WebVTT time syntax (HH:MM:SS.mmm).
 * @param {number} seconds
 * @returns {string}
 */
export function formatVttTimestamp(seconds) {
	const safe = Math.max(0, Number(seconds) || 0);
	const h = Math.floor(safe / 3600)
		.toString()
		.padStart(2, "0");
	const m = Math.floor((safe % 3600) / 60)
		.toString()
		.padStart(2, "0");
	const s = Math.floor(safe % 60)
		.toString()
		.padStart(2, "0");
	const ms = Math.floor((safe % 1) * 1000)
		.toString()
		.padStart(3, "0");
	return `${h}:${m}:${s}.${ms}`;
}
window.formatVttTimestamp = formatVttTimestamp;

/**
 * Escape cue text for plain WebVTT (& < > and newlines → space).
 * @param {unknown} text
 * @returns {string}
 */
export function escapeVttText(text) {
	return String(text ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\r\n|\r|\n/g, " ");
}
window.escapeVttText = escapeVttText;

/**
 * Build plain WebVTT from ordered cues (same end policy as Generate CC).
 * Cue end = next cue start; last cue = min(start+3s, endLimit) when endLimit known.
 * @param {Array<{ start: number, name?: string }>} cues
 * @param {number} [endLimit=0] Export timeline duration (clip end on relative clock)
 * @returns {string|null} Full VTT document, or null when there are no cues
 */
export function buildWebVttFromCues(cues, endLimit = 0) {
	if (!Array.isArray(cues) || cues.length === 0) return null;
	const sorted = [...cues]
		.map((c) => ({
			start: Math.max(0, Number(c.start) || 0),
			name: c.name || "",
		}))
		.sort((a, b) => a.start - b.start);
	const limit = Math.max(0, Number(endLimit) || 0);

	// Plain WebVTT only — no REGION/STYLE/titles
	let vttContent = "WEBVTT\n\n";
	for (let idx = 0; idx < sorted.length; idx++) {
		const startSec = sorted[idx].start;
		let endSec;
		if (idx < sorted.length - 1) {
			endSec = Math.max(startSec, sorted[idx + 1].start);
		} else {
			const holdEnd = startSec + VTT_DEFAULT_CUE_HOLD_SEC;
			endSec = limit > startSec ? Math.min(holdEnd, limit) : holdEnd;
			if (endSec <= startSec) {
				endSec = startSec + VTT_DEFAULT_CUE_HOLD_SEC;
			}
		}
		const cueText = escapeVttText(
			sorted[idx].name || `Marker ${idx + 1}`,
		);
		vttContent += `${formatVttTimestamp(startSec)} --> ${formatVttTimestamp(endSec)}\n${cueText}\n\n`;
	}
	return vttContent;
}

/**
 * Parse a WebVTT / SRT-style timestamp to seconds.
 * Accepts HH:MM:SS.mmm, HH:MM:SS,mmm, MM:SS.mmm.
 * @param {string} ts
 * @returns {number|null}
 */
export function parseVttTimestamp(ts) {
	if (ts == null) return null;
	const cleaned = String(ts).trim().replace(",", ".");
	const parts = cleaned.split(":");
	if (parts.length < 2 || parts.length > 3) return null;
	let h = 0;
	let m = 0;
	let s = 0;
	if (parts.length === 3) {
		h = Number(parts[0]);
		m = Number(parts[1]);
		s = Number(parts[2]);
	} else {
		m = Number(parts[0]);
		s = Number(parts[1]);
	}
	if (![h, m, s].every((n) => Number.isFinite(n))) return null;
	return h * 3600 + m * 60 + s;
}

/**
 * Shift / clip an existing source WebVTT onto the exported trim timeline (clipIn → 0).
 * Soft captions only — no styling blocks rewritten beyond cue times + text.
 * @param {string} vttText
 * @param {number} clipIn
 * @param {number} [clipOut=0] Source-local out; 0 = no upper bound
 * @returns {string|null}
 */
export function shiftWebVttForTrim(vttText, clipIn, clipOut = 0) {
	const text = String(vttText || "");
	if (!text.trim()) return null;
	const inT = Math.max(0, Number(clipIn) || 0);
	const outT = Math.max(0, Number(clipOut) || 0);
	const exportDur = outT > inT ? outT - inT : 0;

	const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
	/** @type {Array<{ start: number, end: number, name: string }>} */
	const parsed = [];
	let i = 0;
	// Skip WEBVTT header / note blocks until first blank after header
	while (i < lines.length && !/-->/.test(lines[i])) i += 1;

	while (i < lines.length) {
		const line = lines[i];
		if (!line || !/-->/.test(line)) {
			i += 1;
			continue;
		}
		const arrow = line.match(/([0-9:.,]+)\s*-->\s*([0-9:.,]+)/);
		if (!arrow) {
			i += 1;
			continue;
		}
		const startSec = parseVttTimestamp(arrow[1]);
		const endSec = parseVttTimestamp(arrow[2]);
		i += 1;
		const textLines = [];
		while (i < lines.length && lines[i].trim() !== "") {
			textLines.push(lines[i]);
			i += 1;
		}
		if (startSec == null || endSec == null) continue;
		// Overlap with [clipIn, clipOut]
		if (outT > inT) {
			if (endSec <= inT || startSec >= outT) continue;
		} else if (endSec <= inT) {
			continue;
		}
		const relStart = Math.max(0, startSec - inT);
		let relEnd = Math.max(relStart, endSec - inT);
		if (exportDur > 0) {
			if (relStart >= exportDur) continue;
			relEnd = Math.min(relEnd, exportDur);
		}
		if (relEnd <= relStart) continue;
		parsed.push({
			start: relStart,
			end: relEnd,
			name: textLines.join(" ").trim(),
		});
	}

	if (parsed.length === 0) return null;

	// Rebuild with exact end times from source (not +3s policy) so existing VTT timing is preserved
	let out = "WEBVTT\n\n";
	for (const c of parsed) {
		out += `${formatVttTimestamp(c.start)} --> ${formatVttTimestamp(c.end)}\n${escapeVttText(c.name)}\n\n`;
	}
	return out;
}

/**
 * Collect export-timeline caption cues for a batch job.
 * Solo: marker times relative to that item's clipIn (export t=0).
 * Join: all markers in the run, ordered by sequence time; each cue offset by
 * the sum of prior segment durations (same spine as join export).
 *
 * @param {{ indices: number[], segments: Array<{ path?: string, start_time?: number, end_time?: number, queueIndex?: number }>, multi?: boolean }} job
 * @param {Array} queue videoQueue
 * @param {{ activeIndex?: number, activeMarkers?: Array }} [opts]
 * @returns {{ cues: Array<{ start: number, name: string }>, endLimit: number, hasMarkers: boolean }}
 */
export function collectBatchExportCaptionCues(job, queue, opts = {}) {
	const cues = [];
	let sequenceOffset = 0;
	const segments = Array.isArray(job?.segments) ? job.segments : [];
	const indices = Array.isArray(job?.indices) ? job.indices : [];

	for (let si = 0; si < segments.length; si++) {
		const seg = segments[si];
		const qi =
			typeof seg.queueIndex === "number"
				? seg.queueIndex
				: typeof indices[si] === "number"
					? indices[si]
					: -1;
		const video = qi >= 0 && queue ? queue[qi] : null;
		const clipIn = Math.max(0, Number(seg.start_time) || 0);
		let clipOut = Math.max(0, Number(seg.end_time) || 0);
		if (clipOut > 0 && clipOut < clipIn) clipOut = clipIn;
		// Prefer explicit export bounds; fall back to media duration for join offsets
		let segDur = 0;
		if (clipOut > clipIn) {
			segDur = clipOut - clipIn;
		} else {
			const mediaDur = Math.max(0, Number(video?.mediaDuration) || 0);
			if (mediaDur > clipIn) segDur = mediaDur - clipIn;
		}

		const sourceMarkers =
			qi === opts.activeIndex && Array.isArray(opts.activeMarkers)
				? opts.activeMarkers
				: video?.appState?.markers || [];

		for (const m of sourceMarkers) {
			const srcT = Number(m?.startTime);
			if (!Number.isFinite(srcT)) continue;
			// Only markers that fall inside the exported trim
			if (srcT < clipIn - 1e-3) continue;
			if (clipOut > clipIn && srcT > clipOut + 1e-3) continue;
			const rel = Math.max(0, srcT - clipIn);
			cues.push({
				start: sequenceOffset + rel,
				name: m?.name || "",
			});
		}

		sequenceOffset += segDur > 0 ? segDur : 0;
	}

	cues.sort((a, b) => a.start - b.start);
	return {
		cues,
		endLimit: sequenceOffset,
		hasMarkers: cues.length > 0,
	};
}

/**
 * After a successful batch video export, write a soft-caption .vtt sidecar
 * next to the output (same basename, .vtt). Never throws to caller for missing
 * captions; write failures propagate so the batch loop can toast-warn only.
 *
 * @param {object} job
 * @param {string} outputVideoPath Absolute path to the exported mp4/etc.
 * @returns {Promise<{ path?: string, skipped?: boolean, reason?: string }>}
 */
async function writeBatchExportSidecarVtt(job, outputVideoPath) {
	if (!outputVideoPath) {
		return { skipped: true, reason: "no-output-path" };
	}

	const queue =
		typeof videoQueue !== "undefined" && Array.isArray(videoQueue)
			? videoQueue
			: [];
	const { cues, endLimit, hasMarkers } = collectBatchExportCaptionCues(
		job,
		queue,
		{
			activeIndex:
				typeof activeQueueIndex !== "undefined" ? activeQueueIndex : -1,
			activeMarkers: typeof markers !== "undefined" ? markers : undefined,
		},
	);

	let vttContent = hasMarkers ? buildWebVttFromCues(cues, endLimit) : null;

	// Solo fallback: existing source VTT/SRT when the item has no markers
	if (!vttContent && !job?.multi && job?.segments?.length === 1) {
		const seg = job.segments[0];
		const sourcePath = seg?.path || "";
		if (sourcePath && window.__TAURI__?.core?.invoke) {
			try {
				let sourceVttPath = null;
				try {
					sourceVttPath = await window.__TAURI__.core.invoke(
						"resolve_subtitles",
						{ videoPath: sourcePath },
					);
				} catch {
					// resolve_subtitles optional
				}
				if (!sourceVttPath) {
					const guess = `${sourcePath.replace(/\.[^/.]+$/, "")}.vtt`;
					const existsFn = window.__TAURI__?.fs?.exists;
					if (existsFn && (await existsFn(guess))) {
						sourceVttPath = guess;
					}
				}
				if (sourceVttPath && window.__TAURI__?.fs?.readTextFile) {
					const raw = await window.__TAURI__.fs.readTextFile(sourceVttPath);
					const clipIn = Math.max(0, Number(seg.start_time) || 0);
					const clipOut = Math.max(0, Number(seg.end_time) || 0);
					vttContent = shiftWebVttForTrim(raw, clipIn, clipOut);
				}
			} catch (readErr) {
				console.warn("[batch VTT] source VTT read failed:", readErr);
			}
		}
	}

	if (!vttContent) {
		return { skipped: true, reason: "no-captions" };
	}

	if (!window.__TAURI__?.core?.invoke) {
		throw new Error("Tauri invoke unavailable for save_vtt_file");
	}

	// save_vtt_file writes <basename>.vtt next to the given video path
	const written = await window.__TAURI__.core.invoke("save_vtt_file", {
		videoPath: outputVideoPath,
		vttText: vttContent,
	});
	return {
		path: typeof written === "string" && written ? written : outputVideoPath,
	};
}
window.writeBatchExportSidecarVtt = writeBatchExportSidecarVtt;

window.toggleClosedCaptions = () => {
	// No VTT / no tracks: disabled control — click is a silent no-op
	if (!window.ccAvailable && !window.isCcActive) {
		const videoProbe =
			(typeof player !== "undefined" && player) ||
			document.getElementById("my_video");
		const hasTracks = !!(
			videoProbe?.textTracks && videoProbe.textTracks.length
		);
		if (!hasTracks) {
			if (typeof window.setCcButtonState === "function") {
				window.setCcButtonState("none");
			}
			return;
		}
		// Tracks exist but flag was stale — treat as available
		window.ccAvailable = true;
	}

	const videoElement =
		(typeof player !== "undefined" && player) ||
		document.getElementById("my_video");
	if (!videoElement) return;

	const turningOn = !window.isCcActive;

	if (turningOn) {
		let trackFound = false;
		for (let i = 0; i < videoElement.textTracks.length; i++) {
			const label = videoElement.textTracks[i].label;
			if (
				label === "Generated Captions" ||
				label === "English" ||
				videoElement.textTracks[i].kind === "captions" ||
				videoElement.textTracks[i].kind === "subtitles"
			) {
				videoElement.textTracks[i].mode = "showing";
				trackFound = true;
			}
		}

		// Still nothing to show — stay dark/disabled (do not auto-generate)
		if (!trackFound) {
			if (typeof window.setCcButtonState === "function") {
				window.setCcButtonState("none");
			}
			return;
		}

		if (typeof window.setCcButtonState === "function") {
			window.setCcButtonState("active");
		}
	} else {
		// Hide cues but keep track nodes so OFF state stays available (white)
		for (let i = 0; i < videoElement.textTracks.length; i++) {
			videoElement.textTracks[i].mode = "disabled";
		}
		if (typeof window.setCcButtonState === "function") {
			window.setCcButtonState("available");
		}
	}
};

/**
 * Build plain WebVTT from markers for the current context and load onto the player.
 * Solo: active video markers, source-local times.
 * Joined multi-clip run: all markers in the run ordered by sequence time (one VTT).
 */
window.triggerVttGeneration = async () => {
	const currentVideo = videoQueue[activeQueueIndex];
	if (!currentVideo?.videoFilePath && !currentVideo?.videoFileName) {
		showToast("No active video found to generate subtitles for", "error");
		return;
	}

	const multi =
		typeof window.isActiveRunMulti === "function" && window.isActiveRunMulti();
	const run =
		typeof window.getActiveJoinRun === "function"
			? window.getActiveJoinRun()
			: null;

	// Collect cues in table order (sequence time when multi)
	let cueStarts = [];
	let cueNames = [];
	let endLimit = 0;

	if (multi && run?.segments?.length > 1) {
		// One VTT on the sequence clock the joined review uses for ordering
		const entries = [];
		for (const seg of run.segments) {
			const sourceMarkers =
				seg.queueIndex === activeQueueIndex
					? markers || []
					: seg.video?.appState?.markers || [];
			for (const m of sourceMarkers) {
				const seqT =
					typeof window.sourceTimeToSequence === "function"
						? window.sourceTimeToSequence(seg.queueIndex, m.startTime, run)
						: m.startTime;
				entries.push({ start: seqT, name: m.name || "" });
			}
		}
		entries.sort((a, b) => a.start - b.start);
		cueStarts = entries.map((e) => e.start);
		cueNames = entries.map((e) => e.name);
		endLimit = Math.max(0, Number(run.totalDuration) || 0);
	} else {
		const list = [...(markers || [])].sort((a, b) => a.startTime - b.startTime);
		cueStarts = list.map((m) => m.startTime);
		cueNames = list.map((m) => m.name || "");
		const playerEl = player || document.getElementById("my_video");
		const clipOut =
			typeof clipOutTime !== "undefined" && clipOutTime > 0
				? clipOutTime
				: playerEl?.duration || 0;
		endLimit = clipOut;
	}

	if (cueStarts.length === 0) {
		showToast("Please add at least one marker to compile captions", "error");
		return;
	}

	const vttCues = cueStarts.map((start, idx) => ({
		start,
		name: cueNames[idx] || "",
	}));
	const vttContent = buildWebVttFromCues(vttCues, endLimit);
	if (!vttContent) {
		showToast("Please add at least one marker to compile captions", "error");
		return;
	}

	const sourcePath = currentVideo.videoFilePath || "";
	const baseName = (
		currentVideo.videoFileName ||
		sourcePath.split(/[/\\]/).pop() ||
		"captions"
	).replace(/\.[^/.]+$/, "");
	const fallbackName = `${baseName || "captions"}.vtt`;

	let vttFilePath = sourcePath
		? sourcePath.replace(/\.[^/.]+$/, "") + ".vtt"
		: "";
	let savedToDisk = false;

	try {
		if (window.__TAURI__?.core?.invoke && sourcePath) {
			const written = await window.__TAURI__.core.invoke("save_vtt_file", {
				videoPath: sourcePath,
				vttText: vttContent,
			});
			if (typeof written === "string" && written) {
				vttFilePath = written;
			}
			savedToDisk = true;
			showToast("Closed captions saved next to video.", "success");
		} else {
			// Browser / no path: download only
			window.downloadVttFallback(vttContent, fallbackName);
			showToast("Closed captions downloaded (no disk path).", "info");
		}
	} catch (writeErr) {
		console.warn("[CC] save_vtt_file failed, offering download:", writeErr);
		const ok = window.downloadVttFallback(vttContent, fallbackName);
		if (ok) {
			showToast(
				"Could not write next to video; downloaded .vtt instead.",
				"warning",
			);
		} else {
			showToast("Failed to write or download subtitle file.", "error");
			return;
		}
	}

	// Load track onto player so CC shows immediately
	if (
		savedToDisk &&
		vttFilePath &&
		typeof window.attachSubtitleTrackFromPath === "function"
	) {
		window.attachSubtitleTrackFromPath(vttFilePath);
	} else if (
		savedToDisk &&
		sourcePath &&
		typeof window.loadSubtitleTrack === "function"
	) {
		await window.loadSubtitleTrack(sourcePath);
	} else if (!savedToDisk && typeof window.clearSubtitleTracks === "function") {
		// Blob fallback: inject via object URL so captions still show without disk
		window.clearSubtitleTracks();
		const videoElement = player || document.getElementById("my_video");
		if (videoElement) {
			const blobUrl = URL.createObjectURL(
				new Blob([vttContent], { type: "text/vtt" }),
			);
			const track = document.createElement("track");
			track.id = "ccTrack";
			track.kind = "captions";
			track.label = "Generated Captions";
			track.srclang = "en";
			track.default = true;
			track.src = blobUrl;
			videoElement.appendChild(track);
			setTimeout(() => {
				for (let i = 0; i < videoElement.textTracks.length; i++) {
					videoElement.textTracks[i].mode =
						videoElement.textTracks[i].label === "Generated Captions"
							? "showing"
							: "disabled";
				}
				if (typeof window.setCcButtonState === "function") {
					window.setCcButtonState("active");
				}
			}, 50);
			if (typeof window.setCcButtonState === "function") {
				window.setCcButtonState("active");
			}
		}
	}
};

// --- EMERGENCY BACKUP VIDEO SRC MONITOR ---
setTimeout(() => {
	const physicalVideoNode =
		document.querySelector("video") || document.getElementById("video-player");
	if (physicalVideoNode) {
		console.log(
			"[Monitor Core] Tracking physical video DOM node properties directly.",
		);

		// Catch native browser-level decoding failures immediately as they paint
		physicalVideoNode.addEventListener("error", (_domErrorEvent) => {
			const err = physicalVideoNode.error;
			const srcNow =
				physicalVideoNode.getAttribute("src") || physicalVideoNode.src || "";
			// Benign only for empty/origin-only MediaError 4 (not every load-in-progress error)
			if (err?.code === 4 && isEmptyOrOriginOnlyMediaSrc(srcNow)) {
				console.warn(
					"[DOM HARDWARE ERROR] Suppressed empty-src error during load transition:",
					srcNow,
					err,
				);
				return;
			}
			console.error(
				"%c[DOM HARDWARE ERROR] WebView2 Media Engine Rejected Source!",
				"background: #d8000c; color: #fff; font-weight: bold; padding: 4px;",
			);
			console.warn(
				"[DOM HARDWARE ERROR] Current active video.src value string is:",
				physicalVideoNode.src,
			);
			console.log(
				"[DOM HARDWARE ERROR] Native Error Code Spec:",
				physicalVideoNode.error,
			);
		});
	}
}, 1500); // Wait for initial project rehydration layout pass to settle

// Export for testing in Node.js environment without breaking browser execution
if (typeof module !== "undefined" && module.exports) {
	module.exports = {
		parseFFmpegTime,
		formatVttTimestamp,
		escapeVttText,
		buildWebVttFromCues,
		parseVttTimestamp,
		shiftWebVttForTrim,
		collectBatchExportCaptionCues,
		normalizeFadeSec,
		clampFadeSec,
		formatFadeBadge,
		computeClipEdgeFadeGain,
		computeClipFadeZoneRanges,
		clampSpeedValue,
		formatSpeedBadge,
		getActiveSpeedMarker,
		buildSpeedRanges,
		getSpeedWarpedDuration,
		sourceTimeToEffective,
		effectiveTimeToSource,
		FADE_DEFAULT_SEC,
		FADE_HARD_MAX_SEC,
		SPEED_MIN,
		SPEED_MAX,
		SPEED_DEFAULT,
	};
}
