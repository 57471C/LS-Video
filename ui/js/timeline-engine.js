/*
 * Timeline Engine Module for TMVideo
 * Manages playhead tracking, ticks rendering, audio canvas painting, and marker/trim shading.
 */

window.playheadAnimationId = null;
window.lastCheckedVideoTime = 0;

let cachedVideoElement = null;

/** Resolve the video element — module-scoped `player` in app.js is not visible here. */
const getPlayer = () =>
	window.player ||
	document.querySelector("video") ||
	document.getElementById("my_video");

const isPlayerReady = () =>
	window.playerReady === true ||
	(typeof playerReady !== "undefined" && playerReady);

// Cache the live HTMLCollection of playheads globally so we don't query the DOM repeatedly in the animation frame
const timelinePlayheadsLive =
	document.getElementsByClassName("sequencer-playhead");

function syncTimelinePlayheadSmoothly() {
	const player = getPlayer();
	if (player && isPlayerReady() && player.duration) {
		const currentVideoTime = player.currentTime;
		const duration = player.duration;

		// Look-ahead intersection delta calculation for jump markers
		if (currentVideoTime > window.lastCheckedVideoTime) {
			if (markers && markers.length > 0) {
				const activeVideo =
					(typeof videoQueue !== "undefined" && videoQueue[activeQueueIndex]) ||
					{};
				const endLimit =
					activeVideo.virtualEndTime !== null &&
					activeVideo.virtualEndTime !== undefined
						? activeVideo.virtualEndTime
						: duration;

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

		const finalVideoTime = player.currentTime;
		const completionPercent = (finalVideoTime / duration) * 100;
		for (let i = 0; i < timelinePlayheadsLive.length; i++) {
			timelinePlayheadsLive[i].style.left = `${completionPercent}%`;
		}
		window.lastCheckedVideoTime = finalVideoTime;
	}
	window.playheadAnimationId = requestAnimationFrame(
		syncTimelinePlayheadSmoothly,
	);
}

const paintTimelineRuler = (duration) => {
	const player = getPlayer();
	if (!player || !duration) return;

	const rulerTrack = document.getElementById("timeline-ruler-track");
	if (!rulerTrack) return;
	rulerTrack.innerHTML = "";
	rulerTrack.style.position = "relative";
	rulerTrack.style.overflow = "hidden";

	// Create playhead
	const playhead = document.createElement("div");
	playhead.className =
		"sequencer-playhead absolute top-0 bottom-0 w-0.5 bg-blue-600 dark:bg-blue-500 pointer-events-none z-30";
	playhead.style.left = `${((player.currentTime || 0) / duration) * 100}%`;
	rulerTrack.appendChild(playhead);

	// Add click to seek
	if (!rulerTrack.dataset.hasClickListener) {
		rulerTrack.addEventListener("click", (e) => {
			const p = getPlayer();
			if (!p) return;
			if (e.target.classList.contains("sequencer-playhead")) return;
			const rect = rulerTrack.getBoundingClientRect();
			const clickX = e.clientX - rect.left;
			const pct = clickX / rect.width;
			p.currentTime = pct * duration;
			const calculatedPercent = pct * 100;
			for (let i = 0; i < timelinePlayheadsLive.length; i++) {
				timelinePlayheadsLive[i].style.left = `${calculatedPercent}%`;
			}
		});
		rulerTrack.dataset.hasClickListener = "true";
	}

	let tickInterval = 5; // seconds
	if (duration <= 15) tickInterval = 1;
	else if (duration <= 60) tickInterval = 5;
	else if (duration <= 300) tickInterval = 15;
	else if (duration <= 1200) tickInterval = 60;
	else tickInterval = 300;

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

const setupVideoTrack = () => {
	const player = getPlayer();
	const videoTrack = document.getElementById("timeline-video-track");
	if (!videoTrack || !player) return;

	// Clear any old playheads
	const oldPlayheads = videoTrack.getElementsByClassName("sequencer-playhead");
	while (oldPlayheads.length > 0) {
		oldPlayheads[0].remove();
	}
	// Keep filmstrip track full-width flex so thumbs stay edge-to-edge under the ruler
	videoTrack.style.position = "relative";
	videoTrack.style.width = "100%";
	videoTrack.style.boxSizing = "border-box";
	videoTrack.style.display = "flex";
	videoTrack.style.overflow = "hidden";
	videoTrack.style.justifyContent = "flex-start";
	videoTrack.style.alignItems = "stretch";

	// Re-apply equal flex on existing filmstrip tiles (no fixed pixel widths)
	const filmstripImgs = videoTrack.querySelectorAll("img");
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

	const playhead = document.createElement("div");
	playhead.className =
		"sequencer-playhead absolute top-0 bottom-0 w-0.5 bg-blue-600 dark:bg-blue-500 pointer-events-none z-30";
	const duration = player.duration || 1;
	playhead.style.left = `${((player.currentTime || 0) / duration) * 100}%`;
	videoTrack.appendChild(playhead);

	// Add click to seek
	if (!videoTrack.dataset.hasClickListener) {
		videoTrack.addEventListener("click", (e) => {
			const p = getPlayer();
			if (!p?.duration) return;
			const rect = videoTrack.getBoundingClientRect();
			const clickX = e.clientX - rect.left;
			const pct = clickX / rect.width;
			p.currentTime = pct * p.duration;
			const calculatedPercent = pct * 100;
			for (let i = 0; i < timelinePlayheadsLive.length; i++) {
				timelinePlayheadsLive[i].style.left = `${calculatedPercent}%`;
			}
		});
		videoTrack.dataset.hasClickListener = "true";
	}
};

const renderAudioWaveformCanvas = () => {
	const player = getPlayer();
	const audioTrack = document.getElementById("timeline-audio-track");
	if (!audioTrack || !player) return;
	audioTrack.innerHTML = "";
	audioTrack.style.position = "relative";

	// Create playhead
	const playhead = document.createElement("div");
	playhead.className =
		"sequencer-playhead absolute top-0 bottom-0 w-0.5 bg-blue-600 dark:bg-blue-500 pointer-events-none z-30";
	const duration = player.duration || 1;
	playhead.style.left = `${((player.currentTime || 0) / duration) * 100}%`;
	audioTrack.appendChild(playhead);

	// Add click to seek
	if (!audioTrack.dataset.hasClickListener) {
		audioTrack.addEventListener("click", (e) => {
			const p = getPlayer();
			if (!p?.duration) return;
			const rect = audioTrack.getBoundingClientRect();
			const clickX = e.clientX - rect.left;
			const pct = clickX / rect.width;
			p.currentTime = pct * p.duration;
			const calculatedPercent = pct * 100;
			for (let i = 0; i < timelinePlayheadsLive.length; i++) {
				timelinePlayheadsLive[i].style.left = `${calculatedPercent}%`;
			}
		});
		audioTrack.dataset.hasClickListener = "true";
	}

	const data = window.currentWaveformData;
	if (!data || data.length === 0) return;

	const canvas = document.createElement("canvas");
	canvas.style.width = "100%";
	canvas.style.height = "100%";
	audioTrack.appendChild(canvas);

	const observer = new ResizeObserver(() => {
		const rect = audioTrack.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;

		const dpr = window.devicePixelRatio || 1;
		canvas.width = rect.width * dpr;
		canvas.height = rect.height * dpr;

		const ctx = canvas.getContext("2d");
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.scale(dpr, dpr);

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
	});
	observer.observe(audioTrack);
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
	if (!videoElement?.duration) return;

	const duration = videoElement.duration;
	const fragment = document.createDocumentFragment();

	// Start/End Trimming Shading
	const startMarker = markers.find(
		(m) => m.type === "in" || m.type === "start",
	);
	if (startMarker && startMarker.startTime > 0) {
		const startPct = (startMarker.startTime / duration) * 100;
		const startShade = document.createElement("div");
		startShade.className =
			"absolute top-0 bottom-0 bg-black/40 dark:bg-black/60";
		startShade.style.left = "0%";
		startShade.style.width = `${startPct}%`;
		fragment.appendChild(startShade);
	}

	const endMarker = markers.find((m) => m.type === "out" || m.type === "end");
	if (endMarker && endMarker.startTime < duration) {
		const endPct = (endMarker.startTime / duration) * 100;
		const endShade = document.createElement("div");
		endShade.className = "absolute top-0 bottom-0 bg-black/40 dark:bg-black/60";
		endShade.style.left = `${endPct}%`;
		endShade.style.width = `${100 - endPct}%`;
		fragment.appendChild(endShade);
	}

	// Loop through markers sequentially
	for (let i = 0; i < markers.length; i += 1) {
		const marker = markers[i];
		const markerLeft = (marker.startTime / duration) * 100;

		// Jump Skipping Shading
		if (marker.type === "jump") {
			const nextMarker = markers[i + 1];
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
			const nextMarker = markers[i + 1];
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

window.syncTimelinePlayheadSmoothly = syncTimelinePlayheadSmoothly;
window.paintTimelineRuler = paintTimelineRuler;
window.setupVideoTrack = setupVideoTrack;
window.renderAudioWaveformCanvas = renderAudioWaveformCanvas;
window.paintTimelineMarkersAndShading = paintTimelineMarkersAndShading;
