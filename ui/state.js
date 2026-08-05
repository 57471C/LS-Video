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

const debuggin = 1;
let videoFileName = "";
let videoFilePath = "";
let projectName = "";
let projectComments = "";
let projectFilePath = "";
let projectFileHandle = null;
let videoQueue = [];
let activeQueueIndex = 0;
const videoBlobCache = {};
let markers = [];
let preserveClipBounds = false;
// biome-ignore lint/style/useConst: Global state modified in other scripts
let durationMode = "hhmmssms";
// biome-ignore lint/style/useConst: Global state modified in other scripts
let playerReady = false;
let clipInTime = 0;
let clipOutTime = 0;
let playbackSpeed = 1;
let volumeLevel = 1;

const APP_VERSION = "0.6.1";
/** Active project localStorage key (writes only go here). */
const PROJECT_STORAGE_KEY = "lfvideo_project";
/** Legacy key from time-study era — read once for migration, never written. */
const LEGACY_PROJECT_STORAGE_KEY = "timeStudyData";

/**
 * Normalize a queue entry: map legacy processStartTime/processEndTime → clipIn/Out.
 * Mutates and returns the video object.
 */
const normalizeVideoClipBounds = (video) => {
	if (!video) return video;
	if (video.clipInTime === undefined || video.clipInTime === null) {
		video.clipInTime = video.processStartTime || 0;
	}
	if (video.clipOutTime === undefined || video.clipOutTime === null) {
		video.clipOutTime = video.processEndTime || 0;
	}
	delete video.processStartTime;
	delete video.processEndTime;
	return video;
};

// biome-ignore lint/style/useConst: Global state modified in other scripts
let isDrawing = false;
let startX;
let startY;
let marqueeOverlay;
let marqueeRect;

const DOM = {
	markersList: document.getElementById("markersList"),
	videoPlaceholder: document.getElementById("videoPlaceholder"),
	videoWrapper: document.getElementById("video-wrapper-id"),

	darkModeToggle: document.getElementById("darkModeToggle"),
	sunIcon: document.getElementById("sunIcon"),
	moonIcon: document.getElementById("moonIcon"),
	currentTime: document.getElementById("currentTime"),
	durationTime: document.getElementById("durationTime"),
	startGreyOut: document.getElementById("startGreyOut"),
	endGreyOut: document.getElementById("endGreyOut"),
	startTick: document.getElementById("startTick"),
	endTick: document.getElementById("endTick"),
	markerTicksContainer: document.getElementById("markerTicksContainer"),
	playIcon: document.getElementById("playIcon"),
	pauseIcon: document.getElementById("pauseIcon"),
	speedValue: document.getElementById("speedValue"),
	volumeOnIcon: document.getElementById("volumeOnIcon"),
	volumeOffIcon: document.getElementById("volumeOffIcon"),
	volumeValue: document.getElementById("volumeValue"),
	video: document.getElementById("my_video"),
	marqueeOverlay: document.getElementById("marqueeOverlay"),
	marqueeRect: document.getElementById("marqueeRect"),
	videoFileInput: document.getElementById("videoFileInput"),
	projectFileInput: document.getElementById("projectFileInput"),
	zoomIn: document.getElementById("zoomIn"),
	zoomOut: document.getElementById("zoomOut"),
	resetZoom: document.getElementById("resetZoom"),
	takeSnapshotBtn: document.getElementById("takeSnapshotBtn"),
	toggleCinemaBtn: document.getElementById("toggleCinemaBtn"),
	projectNameInput: document.getElementById("projectNameInput"),
	videoQueueSelect: document.getElementById("videoQueueSelect"),
	addVideoQueueBtn: document.getElementById("addVideoQueueBtn"),
	editVideoQueueBtn: document.getElementById("editVideoQueueBtn"),
	reorderVideosBtn: document.getElementById("reorder-videos-btn"),
	reorderVideosModal: document.getElementById("reorder-videos-modal"),

	projectCommentsInput: document.getElementById("projectCommentsInput"),
	openSettingsBtn: document.getElementById("openSettingsBtn"),
	settingsBackdrop: document.getElementById("settingsBackdrop"),
	settingsPanel: document.getElementById("settingsPanel"),
	closeSettingsBtn: document.getElementById("closeSettingsBtn"),
};

const saveLocalState = () => {
	if (!videoQueue[activeQueueIndex]) {
		videoQueue[activeQueueIndex] = {
			videoId: activeQueueIndex + 1,
			videoName: `Video ${activeQueueIndex + 1}`,
			appState: {},
		};
	}

	// Sync active global variables to the current video object
	videoQueue[activeQueueIndex].videoFileName = videoFileName;
	videoQueue[activeQueueIndex].videoFilePath = videoFilePath;
	videoQueue[activeQueueIndex].clipInTime = clipInTime;
	videoQueue[activeQueueIndex].clipOutTime = clipOutTime;
	videoQueue[activeQueueIndex].appState = { markers };
	// Drop legacy field names if still present on the active slot
	delete videoQueue[activeQueueIndex].processStartTime;
	delete videoQueue[activeQueueIndex].processEndTime;

	const state = {
		projectMeta: {
			projectName,
			projectComments,
			lastSaved: new Date().toISOString(),
			appVersion: APP_VERSION,
		},
		appConfig: {
			playbackSpeed,
			volumeLevel,
		},
		videoQueue,
		activeQueueIndex,
	};

	localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(state));
	// Stop writing the legacy key; remove any stale copy after successful write
	localStorage.removeItem(LEGACY_PROJECT_STORAGE_KEY);
};

const loadLocalState = () => {
	// Prefer new key; fall back once to legacy timeStudyData for migration
	let data = localStorage.getItem(PROJECT_STORAGE_KEY);
	if (!data) {
		data = localStorage.getItem(LEGACY_PROJECT_STORAGE_KEY);
	}
	let restored = false;

	if (data) {
		try {
			const state = JSON.parse(data);

			if (state.projectMeta) {
				projectName = state.projectMeta.projectName || "";
				projectComments = state.projectMeta.projectComments || "";
			} else {
				projectName = "";
				projectComments = "";
			}

			if (state.appConfig) {
				playbackSpeed =
					state.appConfig.playbackSpeed !== undefined
						? state.appConfig.playbackSpeed
						: 1;
				volumeLevel =
					state.appConfig.volumeLevel !== undefined
						? state.appConfig.volumeLevel
						: 1;
			} else {
				playbackSpeed =
					state.playbackSpeed !== undefined ? state.playbackSpeed : 1;
				volumeLevel = state.volumeLevel !== undefined ? state.volumeLevel : 1;
			}

			if (state.videoQueue && state.videoQueue.length > 0) {
				videoQueue = state.videoQueue.map(normalizeVideoClipBounds);
				activeQueueIndex = state.activeQueueIndex || 0;
			} else {
				videoQueue = [
					{
						videoId: 1,
						videoName: "Video 1",
						videoFileName: "",
						videoFilePath: "",
						clipInTime: 0,
						clipOutTime: 0,
						appState: { markers: [] },
					},
				];
				activeQueueIndex = 0;
			}

			projectFilePath = localStorage.getItem("projectFilePath") || "";
			restored = true;
			toConsole(
				"Project state restored from localStorage",
				"Success",
				debuggin,
			);
		} catch (e) {
			toConsole("Error parsing local state", e, debuggin);
		}
	}

	if (!restored) {
		projectFilePath = "";
		projectName = "";
		projectComments = "";
		videoQueue = [
			{
				videoId: 1,
				videoName: "Video 1",
				videoFileName: "",
				videoFilePath: "",
				clipInTime: 0,
				clipOutTime: 0,
				appState: { markers: [] },
			},
		];
		activeQueueIndex = 0;
	}

	// Hydrate memory with the active video data
	const currentVideo = videoQueue[activeQueueIndex];
	videoFileName = currentVideo.videoFileName || "";
	videoFilePath = currentVideo.videoFilePath || "";
	clipInTime = currentVideo.clipInTime || 0;
	clipOutTime = currentVideo.clipOutTime || 0;

	markers = currentVideo.appState?.markers || [];
	for (const m of markers) {
		if (!m.type) m.type = "standard";
	}

	// Sync UI only — media src is set by callers via window.loadVideo
	// (verify_and_prepare_video proxy). Avoid convertFileSrc here so H.265 works.
	if (DOM.projectNameInput) DOM.projectNameInput.value = projectName;
	if (typeof renderVideoQueueSelect === "function") renderVideoQueueSelect();
};

const exportToJSON = async (isSaveAs = false) => {
	saveLocalState(); // Force sync of globals to current video before export
	const dataStr = localStorage.getItem(PROJECT_STORAGE_KEY);
	if (!dataStr) return;

	let formattedDataStr = dataStr;
	try {
		formattedDataStr = JSON.stringify(JSON.parse(dataStr), null, 2);
	} catch (e) {
		toConsole("Error formatting JSON data for export", e, debuggin);
	}

	let filename = "project.lsv";
	if (projectName) {
		filename = `${sanitizeFilename(projectName)}.lsv`;
	}

	const isTauri = window.__TAURI__ !== undefined;
	if (isTauri) {
		try {
			if (isSaveAs === true || !projectFilePath) {
				const defaultName = projectFilePath
					? projectFilePath.split(/[/\\]/).pop()
					: filename;
				const filePath = await window.__TAURI__.dialog.save({
					filters: [{ name: "LS.Video Project", extensions: ["lsv", "tmv"] }],
					defaultPath: defaultName,
				});
				if (filePath) {
					projectFilePath =
						typeof filePath === "object" ? filePath.path : filePath;
					localStorage.setItem("projectFilePath", projectFilePath);
					await window.__TAURI__.fs.writeTextFile(
						projectFilePath,
						formattedDataStr,
					);
					showToast("Project saved successfully.", "success");
				}
			} else {
				await window.__TAURI__.fs.writeTextFile(
					projectFilePath,
					formattedDataStr,
				);
				showToast("Project saved successfully.", "success");
			}
		} catch (e) {
			toConsole("Error saving project via Tauri", e, debuggin);
			showToast("Error saving project file.", "error");
		}
	} else {
		if (window.showSaveFilePicker) {
			try {
				if (isSaveAs === true || !projectFileHandle) {
					projectFileHandle = await window.showSaveFilePicker({
						suggestedName: filename,
						types: [
							{
								description: "LS.Video Project",
								accept: { "application/json": [".lsv", ".tmv"] },
							},
						],
					});
				}
				const writable = await projectFileHandle.createWritable();
				await writable.write(formattedDataStr);
				await writable.close();
				showToast("Project saved successfully.", "success");
				return;
			} catch (err) {
				if (err.name !== "AbortError") {
					toConsole("Error with showSaveFilePicker", err, debuggin);
				} else {
					return; // User cancelled the prompt
				}
			}
		}

		// Fallback for older browsers
		const blob = new Blob([formattedDataStr], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.setAttribute("href", url);
		link.setAttribute("download", filename);
		link.style.visibility = "hidden";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
		showToast("Project saved successfully.", "success");
	}
};

/**
 * Import a project JSON payload into memory and (optionally) load the active video.
 * @param {string} jsonText
 * @param {{ skipVideoLoad?: boolean }} [options]
 *   skipVideoLoad: when true, only hydrate state (used by .tmvz extract which
 *   re-links temp paths then calls window.loadVideo itself).
 */
const importFromJSON = async (jsonText, options = {}) => {
	const { skipVideoLoad = false } = options;

	if (typeof window.resetVideoViewport === "function") {
		window.resetVideoViewport(player);
	}

	try {
		preserveClipBounds = true;
		const data = JSON.parse(jsonText);

		if (data.videoQueue) {
			videoQueue = data.videoQueue;
			activeQueueIndex = data.activeQueueIndex || 0;
			projectName = data.projectMeta?.projectName || "";
			projectComments = data.projectMeta?.projectComments || "";
		} else {
			alert("Invalid project file format.");
			return;
		}

		// Normalize legacy processStartTime/processEndTime on every queue entry
		videoQueue = videoQueue.map(normalizeVideoClipBounds);

		// Load active video into memory
		const currentVideo = videoQueue[activeQueueIndex];
		videoFileName = currentVideo.videoFileName || "";
		videoFilePath = currentVideo.videoFilePath || "";
		clipInTime = currentVideo.clipInTime || 0;
		clipOutTime = currentVideo.clipOutTime || 0;

		markers = currentVideo.appState?.markers || [];
		for (const m of markers) {
			if (!m.type) m.type = "standard";
		}

		if (DOM.projectNameInput) DOM.projectNameInput.value = projectName;
		if (typeof renderVideoQueueSelect === "function") renderVideoQueueSelect();

		if (DOM.markersList) DOM.markersList.innerHTML = "";

		// Handle Video Relinking
		if (typeof window.resetClosedCaptions === "function") {
			window.resetClosedCaptions();
		}
		player.pause();

		if (!skipVideoLoad) {
			const isTauri = window.__TAURI__ !== undefined;
			if (isTauri && videoFilePath && typeof window.loadVideo === "function") {
				// Filesystem path — route through H.265 proxy
				await window.loadVideo(videoFilePath);
			} else if (videoFileName && videoBlobCache[videoFileName]) {
				// Browser blob cache — intentional exception
				player.src = videoBlobCache[videoFileName];
				player.preload = "metadata";
				toggleVideoPlaceholder(false);
				const ccTrack = document.getElementById("ccTrack");
				if (ccTrack) ccTrack.src = "";
				if (typeof updateLoadButtonColor === "function")
					updateLoadButtonColor();
			} else {
				player.src = "";
				player.removeAttribute("src");
				DOM.videoPlaceholder.textContent = videoFileName
					? `Project loaded. Click here to locate video: ${videoFileName}`
					: "Load a video to get started";
				toggleVideoPlaceholder(true);
				if (typeof updateLoadButtonColor === "function")
					updateLoadButtonColor();
			}
		}

		if (typeof updateMarkersList === "function") updateMarkersList();
		if (typeof drawTable === "function") drawTable();
		if (typeof updateLoadButtonColor === "function") updateLoadButtonColor();

		toConsole(
			"Project imported successfully",
			`Loaded Video: ${currentVideo.videoName}`,
			debuggin,
		);
		showToast("Project loaded successfully.", "success");
		saveLocalState();
	} catch (e) {
		toConsole("Error importing JSON", e, debuggin);
		alert(
			`Error reading project file. It may be corrupted or in an invalid format. Details: ${e.message || e}`,
		);
	}
};

const formatDurationForExport = (ms) => {
	if (durationMode === "hhmmssms") {
		return formatDuration(ms);
	} else if (durationMode === "ms") {
		return ms.toFixed(0);
	} else {
		return (ms / 60000).toFixed(3);
	}
};

const formatZeroDuration = () => {
	if (durationMode === "hhmmssms") return "00:00:00.00";
	if (durationMode === "ms") return "0";
	return "0.00";
};

const escapeCSV = (val) => {
	if (val === undefined || val === null) return "";
	const str = String(val);
	if (
		str.includes(",") ||
		str.includes('"') ||
		str.includes("\n") ||
		str.includes("\r")
	) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
};

const exportToCSV = async () => {
	if (markers.length === 0) {
		alert("No markers to export.");
		return;
	}

	const currentVideo = videoQueue[activeQueueIndex] || {};
	const videoNameVal = currentVideo.videoName || "";

	let csvContent = "";

	// 1. Metadata Block
	// Row 1: Titles
	csvContent += "Project Name,Video Name,Clip In,Clip Out,Video File Name\n";
	// Row 2: Values
	csvContent += `${escapeCSV(projectName)},${escapeCSV(videoNameVal)},${formatTimeToHHMMSSMS(clipInTime)},${formatTimeToHHMMSSMS(clipOutTime)},${escapeCSV(videoFileName)}\n`;
	// Row 3: Blank
	csvContent += "\n";

	// 2. Markers List
	csvContent += "Marker ID,Marker Name,Start Time,Duration (seconds)\n";
	for (let i = 0; i < markers.length; i += 1) {
		const marker = markers[i];
		let duration = 0;
		if (i < markers.length - 1) {
			duration = markers[i + 1].startTime - marker.startTime;
		} else if (typeof player !== "undefined" && player && player.duration) {
			duration = player.duration - marker.startTime;
		}
		duration = Math.max(0, duration);
		csvContent += `${marker.id || i + 1},${escapeCSV(marker.name)},${formatTimeToHHMMSSMS(marker.startTime)},${duration.toFixed(3)}\n`;
	}

	let filename = "markers.csv";
	if (projectName) {
		filename = `${sanitizeFilename(projectName)}_markers.csv`;
	}

	const isTauri = window.__TAURI__ !== undefined;
	if (isTauri) {
		try {
			const filePath = await window.__TAURI__.dialog.save({
				filters: [{ name: "CSV", extensions: ["csv"] }],
				defaultPath: filename,
			});
			if (filePath) {
				const actualPath =
					typeof filePath === "object" ? filePath.path : filePath;
				await window.__TAURI__.fs.writeTextFile(actualPath, csvContent);
				showToast("Data exported to CSV successfully.", "success");
			}
		} catch (e) {
			toConsole("Error exporting CSV via Tauri", e, debuggin);
			showToast("Error exporting CSV file.", "error");
		}
	} else {
		const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.setAttribute("href", url);
		link.setAttribute("download", filename);
		link.style.visibility = "hidden";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
		showToast("Data exported to CSV successfully.", "success");
	}
};
