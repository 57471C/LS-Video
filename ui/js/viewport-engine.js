/*
 * Viewport Scaling and Panning Engine Module for LS.Video
 * Manages cursor-anchored scroll zooming and right-click panning.
 */

export let zoomLevel = 1.0;
export let translateX = 0;
export let translateY = 0;

let videoScale = 1.0;
let videoPanX = 0;
let videoPanY = 0;
let isPanningVideo = false;
let startMouseX = 0;
let startMouseY = 0;

Object.defineProperty(window, "zoomLevel", {
	get() {
		return zoomLevel;
	},
	set(val) {
		zoomLevel = val;
	},
	configurable: true,
});

Object.defineProperty(window, "translateX", {
	get() {
		return translateX;
	},
	set(val) {
		translateX = val;
	},
	configurable: true,
});

Object.defineProperty(window, "translateY", {
	get() {
		return translateY;
	},
	set(val) {
		translateY = val;
	},
	configurable: true,
});

function syncFromGlobals() {
	videoScale = zoomLevel;
	videoPanX = translateX * videoScale;
	videoPanY = translateY * videoScale;
}

function syncToGlobals() {
	zoomLevel = videoScale;
	translateX = videoScale > 0 ? videoPanX / videoScale : 0;
	translateY = videoScale > 0 ? videoPanY / videoScale : 0;
}

export function updateViewportTransform(video) {
	if (!video) return;
	const scale = zoomLevel;
	const tX = translateX;
	const tY = translateY;

	videoScale = scale;
	videoPanX = tX;
	videoPanY = tY;

	if (scale <= 1.0) {
		zoomLevel = 1.0;
		translateX = 0;
		translateY = 0;
		videoScale = 1.0;
		videoPanX = 0;
		videoPanY = 0;
		video.style.transform = "none";
	} else {
		video.style.transformOrigin = "0px 0px";
		video.style.transform = `translate(${tX}px, ${tY}px) scale(${scale})`;
	}
}

export function getNormalizedVideoCoordinates(screenX, screenY, videoRect) {
	return {
		x: (screenX - videoRect.left - translateX) / zoomLevel,
		y: (screenY - videoRect.top - translateY) / zoomLevel,
	};
}

window.getNormalizedVideoCoordinates = getNormalizedVideoCoordinates;

export function initializeVideoViewportZoomPan(videoElement, containerElement) {
	if (!videoElement || !containerElement) return;

	// Intercept scroll event for zooming on containerElement
	containerElement.addEventListener(
		"wheel",
		(event) => {
			event.preventDefault();

			const containerRect = containerElement.getBoundingClientRect();
			const mouseX = event.clientX - containerRect.left;
			const mouseY = event.clientY - containerRect.top;

			const oldZoom = zoomLevel;
			const oldX = translateX;
			const oldY = translateY;

			let targetZoom = oldZoom;
			if (event.deltaY < 0) {
				targetZoom += 0.04;
			} else {
				targetZoom -= 0.04;
			}

			// Clamp zoom level
			targetZoom = Math.min(15.0, Math.max(1.0, targetZoom));

			const scaleRatio = targetZoom / oldZoom;
			zoomLevel = targetZoom;
			translateX = mouseX - (mouseX - oldX) * scaleRatio;
			translateY = mouseY - (mouseY - oldY) * scaleRatio;

			updateViewportTransform(videoElement);
		},
		{ passive: false },
	);

	containerElement.addEventListener("mousedown", (event) => {
		if (event.button === 2) {
			event.preventDefault();
			event.stopPropagation();
			isPanningVideo = true;
			startMouseX = event.clientX;
			startMouseY = event.clientY;
			videoElement.style.cursor = "grabbing";
		}
	});

	// Block context menu inside the container
	containerElement.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		e.stopPropagation();
	});

	containerElement.addEventListener("mousemove", (event) => {
		if (isPanningVideo) {
			const rawDeltaX = event.clientX - startMouseX;
			const rawDeltaY = event.clientY - startMouseY;

			translateX += rawDeltaX;
			translateY += rawDeltaY;

			startMouseX = event.clientX;
			startMouseY = event.clientY;

			updateViewportTransform(videoElement);
		}
	});

	const stopPanning = () => {
		if (isPanningVideo) {
			isPanningVideo = false;
			videoElement.style.cursor = "default";
		}
	};

	containerElement.addEventListener("mouseup", stopPanning);
	containerElement.addEventListener("mouseleave", stopPanning);
}

window.initializeVideoViewportZoomPan = initializeVideoViewportZoomPan;

export function resetVideoViewport(video) {
	videoScale = 1.0;
	videoPanX = 0;
	videoPanY = 0;
	zoomLevel = 1.0;
	translateX = 0;
	translateY = 0;
	if (video) {
		video.style.transform = "none";
	}
}

window.resetVideoViewport = resetVideoViewport;

export const viewportState = {
	syncFromGlobals: syncFromGlobals,
	syncToGlobals: syncToGlobals,
};

window.updateViewportTransform = updateViewportTransform;
window.viewportState = viewportState;
