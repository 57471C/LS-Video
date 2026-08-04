/**
 * Visualizer Engine - Butterchurn (Milkdrop) WebGL Visualizer Integration
 */

let audioContext = null;
let mediaSourceNode = null;
let visualizer = null;
let animFrameId = null;
let presets = {};
let currentPresetKeys = [];
let currentPresetIndex = 0;
let isEnabled = false;
let autoPresetInterval = null;

export function initVisualizerAudio(videoElement) {
	if (!videoElement) return;

	try {
		if (!audioContext) {
			const AudioCtx = window.AudioContext || window.webkitAudioContext;
			if (!AudioCtx) {
				console.warn("[Viz Engine] Web Audio API is not supported.");
				return;
			}
			audioContext = new AudioCtx();
			window._audioContext = audioContext;
		}

		if (!mediaSourceNode) {
			if (window._audioMediaElementSource) {
				mediaSourceNode = window._audioMediaElementSource;
			} else {
				mediaSourceNode = audioContext.createMediaElementSource(videoElement);
				window._audioMediaElementSource = mediaSourceNode;
				// IMPORTANT: Ensure audio still routes to speakers/destination!
				mediaSourceNode.connect(audioContext.destination);
			}
		}

		if (audioContext.state === "suspended") {
			audioContext.resume().catch((err) => {
				console.warn("[Viz Engine] AudioContext resume failed:", err);
			});
		}
	} catch (err) {
		console.warn("[Viz Engine] Failed to initialize Web Audio context:", err);
	}
}

export function initVisualizerCanvas(canvasElement, videoElement) {
	if (!canvasElement || visualizer) return;
	initVisualizerAudio(videoElement);

	if (!audioContext || !mediaSourceNode) return;

	const butterchurn = window.butterchurn;
	const butterchurnPresets = window.butterchurnPresets;

	if (!butterchurn || !butterchurnPresets) {
		console.warn("[Viz Engine] Butterchurn scripts not loaded.");
		return;
	}

	try {
		const width = canvasElement.clientWidth || 580;
		const height = canvasElement.clientHeight || 440;

		visualizer = butterchurn.createVisualizer(audioContext, canvasElement, {
			width,
			height,
			pixelRatio: window.devicePixelRatio || 1,
			textureRatio: 1,
		});

		visualizer.connectAudio(mediaSourceNode);

		presets = butterchurnPresets.getPresets();
		currentPresetKeys = Object.keys(presets);

		if (currentPresetKeys.length > 0) {
			const randomIdx = Math.floor(Math.random() * currentPresetKeys.length);
			currentPresetIndex = randomIdx;
			visualizer.loadPreset(presets[currentPresetKeys[randomIdx]], 0.0);
		}
	} catch (err) {
		console.error("[Viz Engine] Butterchurn creation failed:", err);
	}
}

export function startVisualizer(canvasElement, videoElement) {
	if (!canvasElement) return;

	initVisualizerAudio(videoElement);

	if (audioContext && audioContext.state === "suspended") {
		audioContext.resume().catch(() => {});
	}

	if (!visualizer) {
		initVisualizerCanvas(canvasElement, videoElement);
	}

	if (!visualizer) return;

	isEnabled = true;
	canvasElement.classList.remove("hidden");
	resizeVisualizer(canvasElement);

	if (!animFrameId) {
		const renderLoop = () => {
			if (!isEnabled || !visualizer) {
				animFrameId = null;
				return;
			}
			try {
				visualizer.render();
			} catch (e) {
				console.warn("[Viz Engine] Render error:", e);
			}
			animFrameId = requestAnimationFrame(renderLoop);
		};
		animFrameId = requestAnimationFrame(renderLoop);
	}

	if (!autoPresetInterval && currentPresetKeys.length > 1) {
		autoPresetInterval = setInterval(() => {
			if (isEnabled && visualizer) {
				nextPreset();
			}
		}, 20000);
	}
}

export function stopVisualizer(canvasElement) {
	isEnabled = false;
	if (animFrameId) {
		cancelAnimationFrame(animFrameId);
		animFrameId = null;
	}
	if (autoPresetInterval) {
		clearInterval(autoPresetInterval);
		autoPresetInterval = null;
	}
	if (canvasElement) {
		canvasElement.classList.add("hidden");
	}
}

export function resizeVisualizer(canvasElement) {
	if (!visualizer || !canvasElement) return;
	const parent = canvasElement.parentElement;
	const width = parent ? parent.clientWidth : canvasElement.clientWidth || 580;
	const height = parent
		? parent.clientHeight
		: canvasElement.clientHeight || 440;
	if (width > 0 && height > 0) {
		visualizer.setRendererSize(width, height);
	}
}

export function nextPreset() {
	if (!visualizer || currentPresetKeys.length === 0) return;
	currentPresetIndex = (currentPresetIndex + 1) % currentPresetKeys.length;
	const presetName = currentPresetKeys[currentPresetIndex];
	visualizer.loadPreset(presets[presetName], 2.7);
}

export function isVisualizerActive() {
	return isEnabled;
}
