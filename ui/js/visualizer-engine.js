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
let evalErrorLogged = false;

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

	const butterchurnGlobal = window.butterchurn || window.Butterchurn;
	const presetsGlobal =
		window.butterchurnPresets ||
		window.butterchurnPresetsMinimal ||
		window.ButterchurnPresets;

	console.log(
		"[Viz Engine] Butterchurn global detected:",
		typeof butterchurnGlobal,
		butterchurnGlobal,
	);
	console.log(
		"[Viz Engine] ButterchurnPresets global detected:",
		typeof presetsGlobal,
		presetsGlobal,
	);

	if (!butterchurnGlobal || !presetsGlobal) {
		console.warn("[Viz Engine] Butterchurn scripts not loaded.");
		return;
	}

	const createVisualizerFn =
		butterchurnGlobal.createVisualizer ||
		butterchurnGlobal.default?.createVisualizer ||
		(typeof butterchurnGlobal.default === "function"
			? butterchurnGlobal.default
			: null);

	const getPresetsFn =
		presetsGlobal.getPresets ||
		presetsGlobal.default?.getPresets ||
		(typeof presetsGlobal.default === "function"
			? presetsGlobal.default
			: null);

	if (typeof createVisualizerFn !== "function") {
		console.warn("[Viz Engine] createVisualizer function resolution failed.");
		return;
	}

	try {
		const parent = canvasElement.parentElement;
		const width = parent
			? parent.clientWidth
			: canvasElement.clientWidth || 580;
		const height = parent
			? parent.clientHeight
			: canvasElement.clientHeight || 440;

		visualizer = createVisualizerFn(audioContext, canvasElement, {
			width,
			height,
			pixelRatio: window.devicePixelRatio || 1,
			textureRatio: 1,
		});

		visualizer.connectAudio(mediaSourceNode);

		if (typeof getPresetsFn === "function") {
			presets = getPresetsFn();
		} else if (presetsGlobal && typeof presetsGlobal === "object") {
			presets = presetsGlobal;
		}

		currentPresetKeys = Object.keys(presets);

		if (currentPresetKeys.length > 0) {
			const randomIdx = Math.floor(Math.random() * currentPresetKeys.length);
			currentPresetIndex = randomIdx;
			safeLoadPreset(currentPresetKeys[randomIdx], 0.0);
		}
	} catch (err) {
		console.error("[Viz Engine] Butterchurn creation failed:", err);
		visualizer = null;
	}
}

function safeLoadPreset(presetName, transitionDuration = 2.7) {
	if (!visualizer || !presets[presetName]) return;
	try {
		visualizer.loadPreset(presets[presetName], transitionDuration);
	} catch (err) {
		if (
			err.name === "EvalError" ||
			err instanceof EvalError ||
			err.message?.includes("eval")
		) {
			if (!evalErrorLogged) {
				evalErrorLogged = true;
				console.error(
					"[Viz Engine] Butterchurn preset compilation failed. Ensure CSP script-src includes 'unsafe-eval'.",
					err,
				);
			}
			if (autoPresetInterval) {
				clearInterval(autoPresetInterval);
				autoPresetInterval = null;
			}
		} else {
			console.warn("[Viz Engine] Error loading preset:", err);
		}
	}
}

export function startVisualizer(canvasElement, videoElement) {
	if (!canvasElement) return;

	initVisualizerAudio(videoElement);

	if (audioContext && audioContext.state === "suspended") {
		audioContext.resume().catch(() => {});
	}

	if (videoElement?.muted) {
		videoElement.muted = false;
	}

	if (!visualizer) {
		initVisualizerCanvas(canvasElement, videoElement);
	}

	if (!visualizer) return;

	isEnabled = true;
	canvasElement.classList.remove("hidden");
	resizeVisualizer(canvasElement);

	requestAnimationFrame(() => {
		resizeVisualizer(canvasElement);
	});

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

	if (!autoPresetInterval && visualizer && currentPresetKeys.length > 1) {
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
	if (!canvasElement) return;
	const wrapper =
		document.getElementById("video-wrapper-id") ||
		document.getElementById("video-viewport") ||
		canvasElement.parentElement;
	if (!wrapper) return;

	const w = wrapper.clientWidth;
	const h = wrapper.clientHeight;
	if (w <= 0 || h <= 0) return;

	const dpr = window.devicePixelRatio || 1;
	const physW = Math.max(1, Math.floor(w * dpr));
	const physH = Math.max(1, Math.floor(h * dpr));

	canvasElement.width = physW;
	canvasElement.height = physH;
	canvasElement.style.width = `${w}px`;
	canvasElement.style.height = `${h}px`;

	if (visualizer) {
		try {
			visualizer.setRendererSize(physW, physH);
		} catch (e) {
			try {
				visualizer.setRendererSize(w, h);
			} catch (err) {
				console.warn("[Viz Engine] Resize error:", err);
			}
		}
	}
}

export function nextPreset() {
	if (!visualizer || currentPresetKeys.length === 0) return;
	currentPresetIndex = (currentPresetIndex + 1) % currentPresetKeys.length;
	safeLoadPreset(currentPresetKeys[currentPresetIndex], 2.7);
}

export function isVisualizerActive() {
	return isEnabled;
}

if (typeof window !== "undefined") {
	window.addEventListener("resize", () => {
		const canvas = document.getElementById("vizCanvas");
		if (canvas && isEnabled) {
			resizeVisualizer(canvas);
		}
	});
}
