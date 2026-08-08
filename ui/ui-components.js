const ICONS = {
	trash: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
	jump: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
	capture: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
	standard: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
	jumpType: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><circle cx="6" cy="18" r="2" fill="currentColor"/><circle cx="18" cy="18" r="2" fill="currentColor"/><path d="M6 14C6 8 18 8 18 14"/><path d="M15 11l3 3 3-3"/></svg>`,
	loopType: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`,
	inType: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><path d="M5 4h4v16H5zM19 12l-6-6v12z"/></svg>`,
	outType: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><path d="M15 4h4v16h-4zM5 12l6 6V6z"/></svg>`,
};

const openMarkerMenu = (e, index) => {
	toggleTypeDropdown(e, index);
};
window.openMarkerMenu = openMarkerMenu;

const toggleTypeDropdown = (e, index) => {
	e.stopPropagation();
	const menus = document.querySelectorAll('[id^="type-menu-"]');
	for (const menu of menus) {
		if (menu.id !== `type-menu-${index}`) {
			menu.classList.add("hidden");
		}
	}
	const menu = document.getElementById(`type-menu-${index}`);
	const button = document.getElementById(`type-btn-${index}`);
	if (menu && button) {
		const isOpening = menu.classList.contains("hidden");
		if (isOpening) {
			menu.classList.remove("hidden");
			const rect = button.getBoundingClientRect();
			menu.style.position = "fixed";
			menu.style.top = `${rect.bottom + 4}px`;
			menu.style.left = `${rect.left}px`;
			menu.style.zIndex = "1000";
		} else {
			menu.classList.add("hidden");
		}
	}
};

document.addEventListener("click", (e) => {
	const menus = document.querySelectorAll('[id^="type-menu-"]');
	for (const menu of menus) {
		menu.classList.add("hidden");
	}
	// Clip-edge fade menus (footer Clip In / Clip Out) — close unless click is inside one
	if (!e.target.closest?.(".clip-fade-control")) {
		for (const menu of document.querySelectorAll(".clip-fade-menu")) {
			menu.classList.add("hidden");
		}
	}
});

document.addEventListener(
	"scroll",
	() => {
		const menus = document.querySelectorAll('[id^="type-menu-"]');
		for (const menu of menus) {
			menu.classList.add("hidden");
		}
	},
	{ passive: true, capture: true },
);

const updateStickyOffsets = () => {
	const activeLoggingPanel = document.getElementById("activeLoggingPanel");
	const markersList = document.getElementById("markersList");
	if (!markersList) return;

	const tableHeader = markersList.querySelector("thead");
	if (!tableHeader) return;

	const table = markersList.querySelector("table");
	if (!table) return;

	const scrollContainer = markersList.closest(".overflow-y-auto");
	if (!scrollContainer) return;

	if (scrollContainer === markersList) {
		tableHeader.style.top = "0px";
		return;
	}

	if (!activeLoggingPanel) return;

	const scrollContainerRect = scrollContainer.getBoundingClientRect();
	const tableRect = table.getBoundingClientRect();

	const trs = table.querySelectorAll("tr");
	const lastRow = trs.length > 0 ? trs[trs.length - 1] : null;
	const lastRowBottom = lastRow
		? lastRow.getBoundingClientRect().bottom
		: tableRect.bottom;
	const tableBottom = lastRowBottom - scrollContainerRect.top;

	const headerTop = activeLoggingPanel.offsetHeight;
	const markerRows = markersList.querySelectorAll(".marker-row");
	const markerRowTop = headerTop + tableHeader.offsetHeight;

	const firstMarkerRow = markersList.querySelector(".marker-row");
	const markerRowHeight = firstMarkerRow ? firstMarkerRow.offsetHeight : 0;

	const footer = markersList.querySelector("#markersTableFoot");
	const footerTop = markerRowTop + markerRowHeight;
	const footerHeight = footer ? footer.offsetHeight : 0;

	const fullStackHeight =
		tableHeader.offsetHeight + markerRowHeight + footerHeight;
	let shift = 0;
	if (tableBottom < headerTop + fullStackHeight) {
		shift = headerTop + fullStackHeight - tableBottom;
	}

	tableHeader.style.top = `${headerTop - shift}px`;

	markerRows.forEach((row) => {
		const td = row.querySelector("td");
		if (td) {
			td.style.top = `${markerRowTop - 1 - shift}px`;
			td.style.zIndex = "10";
		}
	});

	if (footer) {
		footer.style.top = `${footerTop - 1 - shift}px`;
	}
};

/** Resolve video element — app.js `let player` is module-scoped; use window.player. */
const getMarkersPlayer = () =>
	window.player ||
	(typeof player !== "undefined" ? player : null) ||
	document.getElementById("my_video") ||
	document.querySelector("video");

/**
 * Build marker rows for the active join run (or solo current source).
 * displayTime is sequence time when multi-clip, else source-local.
 * Entries keep queueIndex + markerIndex for write-back in source-local time.
 */
const getActiveRunMarkerViewEntries = () => {
	const run =
		typeof window.getActiveJoinRun === "function"
			? window.getActiveJoinRun()
			: null;
	const multi = !!(run?.segments && run.segments.length > 1);

	if (!multi) {
		return (markers || []).map((m, i) => ({
			queueIndex: activeQueueIndex,
			markerIndex: i,
			marker: m,
			displayTime: m.startTime,
			isSequence: false,
			clipIn: typeof clipInTime !== "undefined" ? clipInTime : 0,
			clipOut: typeof clipOutTime !== "undefined" ? clipOutTime : 0,
		}));
	}

	const entries = [];
	for (const seg of run.segments) {
		const sourceMarkers =
			seg.queueIndex === activeQueueIndex
				? markers || []
				: seg.video?.appState?.markers || [];
		for (let i = 0; i < sourceMarkers.length; i += 1) {
			const m = sourceMarkers[i];
			const displayTime =
				typeof window.sourceTimeToSequence === "function"
					? window.sourceTimeToSequence(seg.queueIndex, m.startTime, run)
					: m.startTime;
			entries.push({
				queueIndex: seg.queueIndex,
				markerIndex: i,
				marker: m,
				displayTime,
				isSequence: true,
				clipIn: seg.clipIn,
				clipOut: seg.clipOut,
				segment: seg,
			});
		}
	}
	// Sort by SEQUENCE time for multi-clip runs (not raw source-local time alone).
	// Stable tie-break: queue order then source-local index — never shuffle markers between files.
	entries.sort((a, b) => {
		const dt = a.displayTime - b.displayTime;
		if (dt !== 0) return dt;
		if (a.queueIndex !== b.queueIndex) return a.queueIndex - b.queueIndex;
		return a.markerIndex - b.markerIndex;
	});
	return entries;
};

/** Write a source-local startTime for a marker, syncing active globals when needed. */
const writeMarkerLocalTime = (queueIndex, markerIndex, localTime) => {
	if (typeof videoQueue === "undefined" || !videoQueue[queueIndex]?.appState) {
		return;
	}
	if (!videoQueue[queueIndex].appState.markers) {
		videoQueue[queueIndex].appState.markers = [];
	}
	const list =
		queueIndex === activeQueueIndex
			? markers
			: videoQueue[queueIndex].appState.markers;
	if (!list[markerIndex]) return;
	const mType = list[markerIndex].type;
	list[markerIndex].startTime = localTime;
	list.sort((a, b) => a.startTime - b.startTime);
	if (queueIndex === activeQueueIndex) {
		// Keep queue slot in sync
		videoQueue[queueIndex].appState.markers = markers;
	}
	// in/out marker times redefine segment duration → rebuild join layout
	const wasInOut =
		mType === "in" || mType === "out" || mType === "start" || mType === "end";
	if (wasInOut && typeof window.syncClipBoundsFromMarkers === "function") {
		window.syncClipBoundsFromMarkers(queueIndex);
	}
	if (wasInOut && typeof window.scheduleJoinTimelineRebuild === "function") {
		window.scheduleJoinTimelineRebuild();
	}
};

let _updateMarkersListScheduled = false;
const updateMarkersListImmediate = () => {
	const playerEl = getMarkersPlayer();
	if (!playerEl) return;
	try {
		// Re-bind if scripts raced DOM or prior import cleared the ref
		if (!DOM.markersList) {
			DOM.markersList = document.getElementById("markersList");
		}
		if (!DOM.markersList) throw new Error("Markers list element not found");

		const viewEntries = getActiveRunMarkerViewEntries();
		// Stash for edit handlers (time write-back conversion)
		window._markerViewEntries = viewEntries;

		const timeHeader = viewEntries.some((e) => e.isSequence)
			? "Seq Time"
			: "Start Time";

		const rows = [
			`<table class="table table-fixed w-full font-mono text-base tabular-nums [&_th]:align-middle [&_td]:align-middle [&_th]:text-sm sm:[&_th]:text-base [&_td]:text-sm sm:[&_td]:text-base [&_th]:py-1 [&_th]:h-5">
           <thead class="sticky top-0 z-20 text-slate-800 dark:text-slate-100 font-semibold bg-slate-200 dark:bg-slate-800 shadow-sm">
           <tr>
             <th scope="col" class="text-left align-middle w-auto pl-1 sm:pl-2">
               <div class="flex items-center justify-between w-full">
                 <span class="text-sm font-bold">Marker Name</span>
                 <button id="addMarkerBtn" class="btn btn-xs btn-primary shadow-sm py-0.5 px-2 h-6 flex items-center gap-1 text-[11px] font-medium leading-none cursor-pointer">
                   <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                   Add Marker
                 </button>
               </div>
             </th>
             <th scope="col" class="text-center w-[155px] whitespace-nowrap px-1">${timeHeader}</th>
             <th scope="col" class="text-center w-24 whitespace-nowrap px-1">Duration</th>
              <th scope="col" class="text-center w-32 whitespace-nowrap pr-1 sm:pr-2">Actions</th>
           </tr>
         </thead>
         <tbody id="markersTableBodyId">`,
		];
		for (let i = 0; i < viewEntries.length; i += 1) {
			const entry = viewEntries[i];
			const marker = entry.marker;
			const markerTimeInputId = `markerTimeInput-${i}`;
			const displayTime = entry.displayTime;
			const formattedTime = formatTimeToHHMMSSMS(displayTime);
			const safeMarkerName = escapeHTML(marker.name);
			const isNegative = marker.startTime < 0;
			const isInvalid =
				isNegative ||
				marker.startTime < entry.clipIn ||
				(entry.clipOut > 0 && marker.startTime > entry.clipOut);
			const inputClass = isInvalid ? "text-red-500 dark:text-red-400" : "";
			const rowBgClass = isNegative
				? "bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-400"
				: "hover:bg-zinc-50 dark:hover:bg-zinc-800/40";

			// Dynamically calculate Duration (in display timeline units)
			let duration = 0;
			if (i < viewEntries.length - 1) {
				duration = viewEntries[i + 1].displayTime - displayTime;
			} else if (entry.isSequence && entry.segment) {
				const segEnd = entry.segment.offset + entry.segment.duration;
				duration = segEnd - displayTime;
			} else if (playerEl) {
				const activeVideo = videoQueue[activeQueueIndex] || {};
				const endLimit =
					activeVideo.virtualEndTime !== null &&
					activeVideo.virtualEndTime !== undefined
						? activeVideo.virtualEndTime
						: playerEl.duration;
				duration = endLimit - marker.startTime;
			}
			if (duration < 0) duration = 0;

			const absDur = Math.round(duration);
			const hrs = Math.floor(absDur / 3600);
			const mins = Math.floor((absDur % 3600) / 60);
			const secs = absDur % 60;
			const formattedDuration =
				hrs > 0
					? `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
					: `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;

			// Jump/play use display time; sequence mode seeks via seekSequenceTime
			const seekTimeAttr = entry.isSequence ? displayTime : marker.startTime;
			const clipBadge =
				entry.isSequence && entry.queueIndex !== activeQueueIndex
					? `<span class="flex-shrink-0 text-[10px] font-bold text-zinc-400 dark:text-zinc-500" title="Clip ${entry.queueIndex + 1}">${entry.queueIndex + 1}</span>`
					: "";

			// Clip-edge fade badge on in/out bound markers (queue item fade, not playlist)
			const boundVideo =
				typeof videoQueue !== "undefined" ? videoQueue[entry.queueIndex] : null;
			const boundFades =
				typeof window.getVideoFadeSeconds === "function"
					? window.getVideoFadeSeconds(boundVideo, entry.queueIndex)
					: {
							fadeInSec: Number(boundVideo?.fadeInSec) || 0,
							fadeOutSec: Number(boundVideo?.fadeOutSec) || 0,
						};
			const isInBound = marker.type === "in" || marker.type === "start";
			const isOutBound = marker.type === "out" || marker.type === "end";
			const boundFadeBadge =
				isInBound && boundFades.fadeInSec > 0
					? fadeBadgeHtml(boundFades.fadeInSec)
					: isOutBound && boundFades.fadeOutSec > 0
						? fadeBadgeHtml(boundFades.fadeOutSec)
						: "";

			rows.push(`
        <tr class="marker-row ${rowBgClass} border-b border-zinc-200 dark:border-zinc-700" data-view-index="${i}" data-queue-index="${entry.queueIndex}" data-marker-index="${entry.markerIndex}" data-sequence="${entry.isSequence ? "1" : "0"}">
          <td class="pl-1 sm:pl-2 py-2">
            <div class="flex items-center gap-2">
              <button class="flex-shrink-0 text-yellow-500 hover:text-yellow-400 transition-colors focus:outline-none marker-jump-trigger" data-time="${seekTimeAttr}" data-sequence="${entry.isSequence ? "1" : "0"}" title="Jump here (Paused)">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="6" y="4" width="4" height="16"></rect>
                  <rect x="14" y="4" width="4" height="16"></rect>
                </svg>
              </button>
              <button class="flex-shrink-0 text-green-500 hover:text-green-400 transition-colors focus:outline-none marker-play-trigger" data-time="${seekTimeAttr}" data-sequence="${entry.isSequence ? "1" : "0"}" title="Play from here">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
              </button>
              ${clipBadge}
              <input type="text" class="bg-transparent border border-transparent hover:border-zinc-300 dark:hover:border-zinc-700 focus:bg-white dark:focus:bg-zinc-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded px-1 w-full text-sm font-semibold text-zinc-900 dark:text-zinc-200 marker-name-input" data-view-index="${i}" data-queue-index="${entry.queueIndex}" data-marker-index="${entry.markerIndex}" value="${safeMarkerName}" placeholder="Marker ${i + 1}">
              <div class="relative inline-block text-left marker-type-dropdown">
                <button type="button" class="inline-flex items-center justify-center p-1 rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors focus:outline-none cursor-pointer gap-1 marker-context-trigger" data-marker-index="${entry.markerIndex}" data-queue-index="${entry.queueIndex}" data-view-index="${i}" id="type-btn-${i}">
                  ${marker.type === "loop" ? `<span class="px-1 py-0.5 text-[9px] sm:text-[10px] font-bold rounded bg-cyan-100 dark:bg-cyan-950/40 text-cyan-800 dark:text-cyan-400 border border-cyan-200 dark:border-cyan-800/50 leading-none select-none">${marker.loopCount || 1}</span>` : ""}
                  ${boundFadeBadge}
                  ${marker.type === "standard" ? ICONS.standard : marker.type === "jump" ? ICONS.jumpType : marker.type === "loop" ? ICONS.loopType : marker.type === "in" || marker.type === "start" ? ICONS.inType : marker.type === "out" || marker.type === "end" ? ICONS.outType : ICONS.standard}
                </button>
                <div id="type-menu-${i}" class="hidden absolute left-0 mt-1 w-40 rounded-md shadow-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 focus:outline-none z-50">
                  <div class="py-1">
                    <button class="w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 flex items-center gap-2 cursor-pointer font-semibold marker-type-trigger" data-marker-index="${entry.markerIndex}" data-queue-index="${entry.queueIndex}" data-type="standard">
                      ${ICONS.standard} Standard
                    </button>
                    <button class="w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 flex items-center gap-2 cursor-pointer font-semibold marker-type-trigger" data-marker-index="${entry.markerIndex}" data-queue-index="${entry.queueIndex}" data-type="jump">
                      ${ICONS.jumpType} Jump
                    </button>
                    <button class="w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 flex items-center justify-between gap-2 cursor-pointer font-semibold marker-type-trigger" data-marker-index="${entry.markerIndex}" data-queue-index="${entry.queueIndex}" data-type="loop">
                      <span class="flex items-center gap-2">${ICONS.loopType} Loop</span>
                      <input type="text" 
                             class="w-8 text-center text-xs bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded text-zinc-900 dark:text-zinc-100 loop-count-input" 
                             value="${String(marker.loopCount || 1).padStart(2, "0")}" 
                             placeholder="01" 
                             maxlength="2" 
                             data-marker-index="${entry.markerIndex}"
                             data-queue-index="${entry.queueIndex}">
                    </button>
                    <button class="w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 flex items-center gap-2 cursor-pointer font-semibold marker-type-trigger" data-marker-index="${entry.markerIndex}" data-queue-index="${entry.queueIndex}" data-type="in">
                      ${ICONS.inType} Set Clip In
                    </button>
                    <button class="w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 flex items-center gap-2 cursor-pointer font-semibold marker-type-trigger" data-marker-index="${entry.markerIndex}" data-queue-index="${entry.queueIndex}" data-type="out">
                      ${ICONS.outType} Set Clip Out
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </td>
          <td class="text-center py-2">
            <span class="inline-flex items-center gap-1">
              <input type="text" id="${markerTimeInputId}" class="form-control w-28 px-1 text-center font-mono tabular-nums text-sm ${inputClass}" value="${formattedTime}" data-view-index="${i}">
              <button class="p-1 text-zinc-400 hover:text-blue-500 transition-colors marker-sync-trigger" data-view-index="${i}" data-marker-index="${entry.markerIndex}" data-queue-index="${entry.queueIndex}" title="Sync to Playhead">${ICONS.capture}</button>
            </span>
          </td>
          <td class="text-center py-2">
            <span class="font-mono text-sm text-zinc-600 dark:text-zinc-400">${formattedDuration}</span>
          </td>
          <td class="text-center py-2 pr-1 sm:pr-2">
            <div class="flex gap-1.5 justify-center">
              
              <button class="btn btn-outline-danger p-1 flex items-center justify-center marker-delete-trigger" data-marker-index="${entry.markerIndex}" data-queue-index="${entry.queueIndex}" title="Delete Marker">${ICONS.trash}</button>
            </div>
          </td>
        </tr>
      `);
		}

		rows.push(`
        </tbody>
      </table>
      <div id="markersTableFoot" class="sticky z-20 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-[0_-2px_4px_rgba(0,0,0,0.05)] mt-[-1px] rounded-b-md"></div>
    `);

		DOM.markersList.innerHTML = rows.join("");

		// #addMarkerBtn lives in <thead>, not tbody — re-bind after every re-render
		// (innerHTML destroys the previous node; Enter uses window.addMarker directly).
		const addMarkerBtnEl = document.getElementById("addMarkerBtn");
		if (addMarkerBtnEl) {
			addMarkerBtnEl.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (typeof window.addMarker === "function") {
					window.addMarker();
				}
			});
		}

		// Delegate row actions from the list host so thead + tbody both work after re-render
		if (!DOM.markersList.dataset.markerClickBound) {
			DOM.markersList.dataset.markerClickBound = "1";
			DOM.markersList.addEventListener("click", async (event) => {
				// Add Marker (header button; also covered by re-bind above)
				const addBtn = event.target.closest("#addMarkerBtn");
				if (addBtn) {
					event.preventDefault();
					event.stopPropagation();
					if (typeof window.addMarker === "function") {
						window.addMarker();
					}
					return;
				}

				// 1. Context trigger
				const contextBtn = event.target.closest(".marker-context-trigger");
				if (contextBtn) {
					event.preventDefault();
					event.stopPropagation();
					const viewIndex = parseInt(
						contextBtn.getAttribute("data-view-index") ??
							contextBtn.getAttribute("data-marker-index"),
						10,
					);
					if (typeof openMarkerMenu === "function") {
						openMarkerMenu(event, viewIndex);
					}
					return;
				}

				// 2. Jump trigger (sequence time when data-sequence=1)
				const jumpBtn = event.target.closest(".marker-jump-trigger");
				if (jumpBtn) {
					event.preventDefault();
					event.stopPropagation();
					const time = parseFloat(jumpBtn.getAttribute("data-time"));
					const isSeq = jumpBtn.getAttribute("data-sequence") === "1";
					if (isSeq && typeof window.seekSequenceTime === "function") {
						void window.seekSequenceTime(time, {
							play: false,
							silent: true,
						});
					} else if (typeof window.jumpToMarkerTime === "function") {
						window.jumpToMarkerTime(time);
					}
					return;
				}

				// 3. Play trigger
				const playBtn = event.target.closest(".marker-play-trigger");
				if (playBtn) {
					event.preventDefault();
					event.stopPropagation();
					const time = parseFloat(playBtn.getAttribute("data-time"));
					const isSeq = playBtn.getAttribute("data-sequence") === "1";
					if (isSeq && typeof window.seekSequenceTime === "function") {
						void window.seekSequenceTime(time, {
							play: true,
							silent: true,
						});
					} else if (typeof window.playFromMarkerTime === "function") {
						window.playFromMarkerTime(time);
					}
					return;
				}

				// 4. Sync trigger — write playhead as source-local (convert from sequence when joined)
				const syncBtn = event.target.closest(".marker-sync-trigger");
				if (syncBtn) {
					event.preventDefault();
					event.stopPropagation();
					const markerIndex = parseInt(
						syncBtn.getAttribute("data-marker-index"),
						10,
					);
					const queueIndex = parseInt(
						syncBtn.getAttribute("data-queue-index") ?? activeQueueIndex,
						10,
					);
					const viewIndex = parseInt(
						syncBtn.getAttribute("data-view-index"),
						10,
					);
					const entry = window._markerViewEntries?.[viewIndex];
					if (
						entry?.isSequence &&
						typeof window.getSequencePlayheadTime === "function"
					) {
						const seqT = window.getSequencePlayheadTime();
						const localT =
							typeof window.sequenceTimeToSource === "function"
								? window.sequenceTimeToSource(seqT)?.localTime
								: seqT - (entry.segment?.offset || 0) + (entry.clipIn || 0);
						// Map sequence playhead into this marker's source
						let writeLocal = localT;
						if (entry.segment && entry.queueIndex !== activeQueueIndex) {
							// Convert sequence time into this entry's source local
							const mapped = window.sequenceTimeToSource?.(seqT);
							if (mapped && mapped.queueIndex === entry.queueIndex) {
								writeLocal = mapped.localTime;
							} else {
								// Clamp playhead into this segment's local range via sequence offset
								writeLocal =
									entry.clipIn +
									Math.max(
										0,
										Math.min(
											entry.segment.duration,
											seqT - entry.segment.offset,
										),
									);
							}
						}
						writeMarkerLocalTime(queueIndex, markerIndex, writeLocal);
						saveLocalState();
						updateMarkersList();
					} else if (typeof window.syncMarkerToPlayhead === "function") {
						window.syncMarkerToPlayhead(markerIndex);
					}
					return;
				}

				// 5. Delete trigger (may target non-active queue source in a join run)
				const deleteBtn = event.target.closest(".marker-delete-trigger");
				if (deleteBtn) {
					event.preventDefault();
					event.stopPropagation();
					const markerIndex = parseInt(
						deleteBtn.getAttribute("data-marker-index"),
						10,
					);
					const queueIndex = parseInt(
						deleteBtn.getAttribute("data-queue-index") ?? activeQueueIndex,
						10,
					);
					if (queueIndex === activeQueueIndex) {
						if (typeof window.deleteMarker === "function") {
							window.deleteMarker(markerIndex);
						}
					} else if (videoQueue[queueIndex]?.appState?.markers) {
						const name =
							videoQueue[queueIndex].appState.markers[markerIndex]?.name ||
							"marker";
						if (
							typeof asyncConfirm === "function"
								? await asyncConfirm(
										`Are you sure you want to delete the marker "${name}"? This action cannot be undone.`,
										"Delete Marker",
									)
								: confirm(`Delete marker "${name}"?`)
						) {
							videoQueue[queueIndex].appState.markers.splice(markerIndex, 1);
							if (typeof window.syncClipBoundsFromMarkers === "function") {
								window.syncClipBoundsFromMarkers(queueIndex);
							}
							saveLocalState();
							updateMarkersList();
							if (typeof window.paintTimelineMarkersAndShading === "function") {
								window.paintTimelineMarkersAndShading();
							}
							if (typeof window.scheduleJoinTimelineRebuild === "function") {
								window.scheduleJoinTimelineRebuild();
							}
						}
					}
					return;
				}

				// 6. Type dropdown items trigger
				const typeBtn = event.target.closest(".marker-type-trigger");
				if (typeBtn) {
					event.preventDefault();
					event.stopPropagation();
					const markerIndex = parseInt(
						typeBtn.getAttribute("data-marker-index"),
						10,
					);
					const qIndex = parseInt(
						typeBtn.getAttribute("data-queue-index") ?? activeQueueIndex,
						10,
					);
					const type = typeBtn.getAttribute("data-type");
					if (qIndex === activeQueueIndex) {
						if (typeof window.updateMarkerType === "function") {
							window.updateMarkerType(markerIndex, type);
						}
					} else if (videoQueue[qIndex]?.appState?.markers?.[markerIndex]) {
						const m = videoQueue[qIndex].appState.markers[markerIndex];
						m.type = type;
						if (type === "loop") {
							m.loopCount = m.loopCount || 1;
						}
						// Non-active clip in/out still reshapes the join spine
						if (typeof window.syncClipBoundsFromMarkers === "function") {
							window.syncClipBoundsFromMarkers(qIndex);
						}
						saveLocalState();
						updateMarkersList();
						if (typeof window.paintTimelineMarkersAndShading === "function") {
							window.paintTimelineMarkersAndShading();
						}
						if (typeof window.updateSliderTicks === "function") {
							window.updateSliderTicks();
						}
						if (
							(type === "in" ||
								type === "out" ||
								type === "start" ||
								type === "end") &&
							typeof window.scheduleJoinTimelineRebuild === "function"
						) {
							window.scheduleJoinTimelineRebuild();
						}
					}
					return;
				}
			});
		}

		const markerTableBody =
			document.getElementById("markersTableBodyId") ||
			document.querySelector(".markers-table");

		if (markerTableBody) {
			// Attach name input change listeners (terry/tetris easter egg via updateMarkerName)
			markerTableBody
				.querySelectorAll(".marker-name-input")
				.forEach((input) => {
					input.addEventListener("change", () => {
						const index = parseInt(input.getAttribute("data-marker-index"), 10);
						const qIndex = parseInt(
							input.getAttribute("data-queue-index") ?? activeQueueIndex,
							10,
						);
						if (qIndex === activeQueueIndex) {
							if (typeof window.updateMarkerName === "function") {
								window.updateMarkerName(index, input.value);
							}
						} else if (videoQueue[qIndex]?.appState?.markers?.[index]) {
							const trimmed = input.value.trim();
							if (!trimmed) {
								alert("Marker name cannot be empty.");
								updateMarkersList();
								return;
							}
							videoQueue[qIndex].appState.markers[index].name = trimmed;
							saveLocalState();
						}
					});
				});

			// Attach loop count input event handlers
			// Editing ## must also set type === "loop" (badge, cyan band, seektimeupdate)
			const applyLoopCountEdit = (
				index,
				rawValue,
				{ reRender = false } = {},
			) => {
				const digits = String(rawValue ?? "").replace(/\D/g, "");
				const parsed = parseInt(digits, 10);
				const finalVal = !Number.isNaN(parsed)
					? Math.min(99, Math.max(1, parsed))
					: 1;
				if (!markers[index]) return finalVal;
				markers[index].type = "loop";
				markers[index].loopCount = finalVal;
				saveLocalState();
				if (reRender) {
					if (typeof window.updateMarkersList === "function") {
						window.updateMarkersList();
					} else if (typeof updateMarkersList === "function") {
						updateMarkersList();
					}
					if (typeof window.paintTimelineMarkersAndShading === "function") {
						window.paintTimelineMarkersAndShading();
					}
				}
				return finalVal;
			};

			markerTableBody.querySelectorAll(".loop-count-input").forEach((input) => {
				const index = parseInt(input.getAttribute("data-marker-index"), 10);
				input.addEventListener("click", (e) => e.stopPropagation());
				input.addEventListener("mousedown", (e) => e.stopPropagation());
				input.addEventListener("mouseup", (e) => e.stopPropagation());
				input.addEventListener("focus", (e) => e.stopPropagation());
				input.addEventListener("blur", (e) => {
					e.stopPropagation();
					// Commit type=loop + count on blur so badge/timeline update without waiting for change
					const finalVal = applyLoopCountEdit(index, input.value, {
						reRender: true,
					});
					input.value = String(finalVal).padStart(2, "0");
				});
				input.addEventListener("input", (e) => {
					e.stopPropagation();
					input.value = input.value.replace(/\D/g, "");
					// Persist type+count while typing; defer re-render to avoid focus loss
					applyLoopCountEdit(index, input.value, { reRender: false });
				});
				input.addEventListener("change", (e) => {
					e.stopPropagation();
					const finalVal = applyLoopCountEdit(index, input.value, {
						reRender: true,
					});
					input.value = String(finalVal).padStart(2, "0");
				});
			});
		}

		DOM.markersTableFoot = document.getElementById("markersTableFoot");
		const table = DOM.markersList.querySelector("table");
		if (!table) throw new Error("Markers table element not found");
		table.style.display = "table";
		updateVideoTimeSummary();

		// Attach listeners for manual input typing in start times (sequence → local on write)
		for (let i = 0; i < viewEntries.length; i += 1) {
			const markerTimeInput = document.getElementById(`markerTimeInput-${i}`);
			if (markerTimeInput) {
				markerTimeInput.addEventListener("change", (event) => {
					const entry = window._markerViewEntries?.[i] || viewEntries[i];
					const newDisplayTime = parseTimeFromHHMMSSMS(event.target.value);
					if (newDisplayTime !== null && entry) {
						let localTime = newDisplayTime;
						if (entry.isSequence && entry.segment) {
							// Sequence time → source-local
							localTime =
								entry.clipIn +
								Math.max(0, newDisplayTime - entry.segment.offset);
						}
						writeMarkerLocalTime(
							entry.queueIndex,
							entry.markerIndex,
							localTime,
						);
						saveLocalState();
						updateVideoTimeSummary();
						updateMarkersList();
						if (typeof window.paintTimelineMarkersAndShading === "function") {
							window.paintTimelineMarkersAndShading();
						}
					} else {
						alert(
							"Invalid time format. Please use HH:MM:SS.MS (e.g., 00:01:00.00).",
						);
						const fallback =
							entry?.displayTime ?? entry?.marker?.startTime ?? 0;
						markerTimeInput.value = formatTimeToHHMMSSMS(fallback);
					}
				});
			}
		}

		if (typeof window.updateSliderTicks === "function") {
			window.updateSliderTicks();
		} else if (typeof updateSliderTicks === "function") {
			updateSliderTicks();
		}
		if (typeof window.paintTimelineMarkersAndShading === "function") {
			window.paintTimelineMarkersAndShading();
		}
	} catch (error) {
		toConsole("updateMarkersList error", error.message, debuggin);
	}
};

const updateMarkersList = () => {
	if (_updateMarkersListScheduled) return;
	_updateMarkersListScheduled = true;
	requestAnimationFrame(() => {
		_updateMarkersListScheduled = false;
		updateMarkersListImmediate();
	});
};
// Classic-script globals + window aliases for module consumers
window.updateMarkersList = updateMarkersList;

/**
 * Badge HTML for clip-edge fade (same visual language as loop ## badge).
 * @param {number} fadeSec
 * @returns {string}
 */
const fadeBadgeHtml = (fadeSec) => {
	const label =
		typeof window.formatFadeBadge === "function"
			? window.formatFadeBadge(fadeSec)
			: fadeSec > 0
				? `${Number(fadeSec).toFixed(1)}s`
				: "";
	if (!label) return "";
	return `<span class="px-1 py-0.5 text-[9px] sm:text-[10px] font-bold rounded bg-cyan-100 dark:bg-cyan-950/40 text-cyan-800 dark:text-cyan-400 border border-cyan-200 dark:border-cyan-800/50 leading-none select-none" title="Clip-edge fade">${label}</span>`;
};

/**
 * Footer Clip In / Clip Out control with fade context menu (not playlist).
 * @param {"in"|"out"} edge
 * @param {string} label
 * @param {string} timeStr
 * @param {number} fadeSec
 * @param {string} timeId
 * @returns {string}
 */
const renderClipBoundFadeControl = (edge, label, timeStr, fadeSec, timeId) => {
	const defaultSec =
		fadeSec > 0
			? Number(fadeSec).toFixed(1)
			: String(
					typeof window.FADE_DEFAULT_SEC === "number"
						? window.FADE_DEFAULT_SEC.toFixed(1)
						: "1.0",
				);
	const badge = fadeBadgeHtml(fadeSec);
	const menuTitle = edge === "out" ? "Fade Out" : "Fade In";
	return `
    <span class="relative inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400 clip-fade-control" data-fade-edge="${edge}">
      <button type="button" class="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors focus:outline-none cursor-pointer clip-fade-trigger" data-fade-edge="${edge}" title="${menuTitle} (export filter)">
        <span>${label}:</span>
        <span id="${timeId}" class="font-mono font-bold text-zinc-900 dark:text-white">${timeStr}</span>
        ${badge}
      </button>
      <div id="clip-fade-menu-${edge}" class="clip-fade-menu hidden absolute left-0 bottom-full mb-1 w-44 rounded-md shadow-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 focus:outline-none z-50">
        <div class="py-1">
          <div class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${menuTitle}</div>
          <div class="px-3 py-1.5 flex items-center gap-1.5">
            <input type="text" inputmode="decimal"
              class="w-12 text-center text-xs bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded text-zinc-900 dark:text-zinc-100 clip-fade-input"
              value="${defaultSec}" maxlength="5" data-fade-edge="${edge}"
              title="Seconds (e.g. 0.5, 1.0, 1.5)">
            <span class="text-xs text-zinc-500">s</span>
            <button type="button" class="btn btn-xs btn-outline-secondary py-0.5 px-2 h-6 text-[11px] clip-fade-apply" data-fade-edge="${edge}">Set</button>
          </div>
          <button type="button" class="w-full text-left px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 cursor-pointer font-semibold clip-fade-clear" data-fade-edge="${edge}">
            Clear fade
          </button>
        </div>
      </div>
    </span>`;
};

/** Wire footer Clip In/Out fade menus after footer.innerHTML. */
const bindClipFadeFooterControls = () => {
	const closeAllFadeMenus = () => {
		for (const menu of document.querySelectorAll(".clip-fade-menu")) {
			menu.classList.add("hidden");
		}
	};

	const applyFade = (edge, rawValue) => {
		const def =
			typeof window.FADE_DEFAULT_SEC === "number"
				? window.FADE_DEFAULT_SEC
				: 1.0;
		let parsed = Number.parseFloat(String(rawValue ?? "").replace(",", "."));
		if (!Number.isFinite(parsed) || parsed <= 0) parsed = def;
		if (typeof window.setVideoFadeSec === "function") {
			window.setVideoFadeSec(edge, parsed, activeQueueIndex);
		} else if (
			typeof videoQueue !== "undefined" &&
			videoQueue[activeQueueIndex]
		) {
			const key = edge === "out" ? "fadeOutSec" : "fadeInSec";
			videoQueue[activeQueueIndex][key] = parsed;
			if (typeof saveLocalState === "function") saveLocalState();
		}
		if (typeof window.updateVideoTimeSummary === "function") {
			window.updateVideoTimeSummary();
		}
	};

	const clearFade = (edge) => {
		if (typeof window.setVideoFadeSec === "function") {
			window.setVideoFadeSec(edge, 0, activeQueueIndex);
		} else if (
			typeof videoQueue !== "undefined" &&
			videoQueue[activeQueueIndex]
		) {
			const key = edge === "out" ? "fadeOutSec" : "fadeInSec";
			videoQueue[activeQueueIndex][key] = 0;
			if (typeof saveLocalState === "function") saveLocalState();
		}
		if (typeof window.updateVideoTimeSummary === "function") {
			window.updateVideoTimeSummary();
		}
	};

	for (const trigger of document.querySelectorAll(".clip-fade-trigger")) {
		trigger.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const edge = trigger.getAttribute("data-fade-edge");
			const menu = document.getElementById(`clip-fade-menu-${edge}`);
			if (!menu) return;
			const wasHidden = menu.classList.contains("hidden");
			closeAllFadeMenus();
			// Also close marker type menus
			for (const m of document.querySelectorAll('[id^="type-menu-"]')) {
				m.classList.add("hidden");
			}
			if (wasHidden) {
				menu.classList.remove("hidden");
				const input = menu.querySelector(".clip-fade-input");
				if (input) {
					// First-time set: input already prefills 1.0 when fade is 0
					input.focus();
					input.select();
				}
			}
		});
	}

	for (const input of document.querySelectorAll(".clip-fade-input")) {
		input.addEventListener("click", (e) => e.stopPropagation());
		input.addEventListener("mousedown", (e) => e.stopPropagation());
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				const edge = input.getAttribute("data-fade-edge");
				applyFade(edge, input.value);
			} else if (e.key === "Escape") {
				closeAllFadeMenus();
			}
		});
	}

	for (const btn of document.querySelectorAll(".clip-fade-apply")) {
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const edge = btn.getAttribute("data-fade-edge");
			const menu = document.getElementById(`clip-fade-menu-${edge}`);
			const input = menu?.querySelector(".clip-fade-input");
			applyFade(edge, input?.value);
		});
	}

	for (const btn of document.querySelectorAll(".clip-fade-clear")) {
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const edge = btn.getAttribute("data-fade-edge");
			clearFade(edge);
		});
	}
};

const updateVideoTimeSummary = () => {
	try {
		let footer = document.getElementById("markersTableFoot");
		// Footer is created by updateMarkersListImmediate; ensure shell exists first
		if (!footer) {
			const playerEl = getMarkersPlayer();
			if (playerEl && DOM.markersList) {
				updateMarkersListImmediate();
				footer = document.getElementById("markersTableFoot");
			}
		}
		if (!footer) {
			// Still missing — list not ready yet; silent skip (avoid spam)
			return;
		}

		const playerEl = getMarkersPlayer();
		const activeVideo =
			(typeof videoQueue !== "undefined" && videoQueue[activeQueueIndex]) || {};

		// Multi-clip join run: footer reflects SEQUENCE bounds (sum of segment lengths).
		// Solo / unjoined: keep per-clip Clip In / Out / Duration behaviour.
		const multi =
			typeof window.isActiveRunMulti === "function" &&
			window.isActiveRunMulti();
		const generateCcBtnHtml = `
        <button type="button" id="generateCcBtn" class="btn btn-xs btn-outline-secondary py-0.5 px-2 h-6 text-[11px] font-medium leading-none cursor-pointer whitespace-nowrap" title="Generate WebVTT closed captions from markers">
          Generate CC
        </button>`;

		// Always keep clipIn/Out in sync with in/out markers (drives join segment offsets).
		if (typeof window.syncClipBoundsFromMarkers === "function") {
			window.syncClipBoundsFromMarkers(activeQueueIndex);
		}

		const fades =
			typeof window.getVideoFadeSeconds === "function"
				? window.getVideoFadeSeconds(activeVideo, activeQueueIndex)
				: {
						fadeInSec: Number(activeVideo.fadeInSec) || 0,
						fadeOutSec: Number(activeVideo.fadeOutSec) || 0,
					};

		if (multi) {
			const run =
				typeof window.getActiveJoinRun === "function"
					? window.getActiveJoinRun()
					: null;
			// Sequence start is always 0 on the spine (first segment offset).
			const seqIn = 0;
			const seqOut = Math.max(0, Number(run?.totalDuration) || 0);
			const seqDur = seqOut;
			const formattedStartTime = formatTimeToHHMMSSMS(seqIn);
			const formattedEndTime = formatTimeToHHMMSSMS(seqOut);
			const formattedDuration = formatTimeToHHMMSSMS(seqDur);

			// Active clip bounds for fade editing (not playlist-level)
			const activeIn =
				typeof clipInTime !== "undefined" ? clipInTime : activeVideo.clipInTime || 0;
			const activeOut =
				typeof clipOutTime !== "undefined"
					? clipOutTime
					: activeVideo.clipOutTime || 0;
			const activeInStr = formatTimeToHHMMSSMS(activeIn);
			const activeOutStr = formatTimeToHHMMSSMS(activeOut);

			footer.innerHTML = `
      <div class="flex flex-col items-center gap-1 w-full py-1 text-sm font-medium">
        <div class="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 w-full">
          <span class="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
            <span>Seq In:</span>
            <span id="videoStartTimeDisplay" class="font-mono font-bold text-zinc-900 dark:text-white">${formattedStartTime}</span>
          </span>
          <span class="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
            <span>Seq Out:</span>
            <span id="videoEndTimeDisplay" class="font-mono font-bold text-zinc-900 dark:text-white">${formattedEndTime}</span>
          </span>
          <span class="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
            <span>Sequence Duration:</span>
            <span id="videoDurationDisplay" class="font-mono font-bold text-zinc-900 dark:text-white">${formattedDuration}</span>
          </span>
          ${generateCcBtnHtml}
        </div>
        <div class="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 w-full text-xs">
          ${renderClipBoundFadeControl("in", "Clip In", activeInStr, fades.fadeInSec, "activeClipInTimeDisplay")}
          ${renderClipBoundFadeControl("out", "Clip Out", activeOutStr, fades.fadeOutSec, "activeClipOutTimeDisplay")}
        </div>
      </div>
    `;
			const genBtn = document.getElementById("generateCcBtn");
			if (genBtn && typeof window.triggerVttGeneration === "function") {
				genBtn.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					window.triggerVttGeneration();
				});
			}
			bindClipFadeFooterControls();
			return;
		}

		const startMarker = markers.find(
			(m) => m.type === "in" || m.type === "start",
		);
		clipInTime = startMarker ? startMarker.startTime : 0;

		const endMarker = markers.find((m) => m.type === "out" || m.type === "end");
		if (endMarker) {
			clipOutTime = endMarker.startTime;
		} else if (playerEl?.duration && !preserveClipBounds) {
			clipOutTime = playerEl.duration;
		} else if (!preserveClipBounds) {
			clipOutTime = 0;
		}

		let duration = clipOutTime - clipInTime;
		if (duration < 0) duration = 0;

		if (markers.length > 0) {
			for (let i = 0; i < markers.length; i += 1) {
				if (markers[i].type === "jump") {
					let markerDur = 0;
					if (i < markers.length - 1) {
						markerDur = markers[i + 1].startTime - markers[i].startTime;
					} else {
						markerDur = clipOutTime - markers[i].startTime;
					}
					if (markerDur > 0) {
						duration -= markerDur;
					}
				}
			}
		}
		if (duration < 0) duration = 0;

		const formattedStartTime = formatTimeToHHMMSSMS(clipInTime);
		const formattedEndTime = formatTimeToHHMMSSMS(clipOutTime);
		const formattedDuration = formatTimeToHHMMSSMS(duration);

		footer.innerHTML = `
      <div class="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 w-full py-1 text-sm font-medium">
        ${renderClipBoundFadeControl("in", "Clip In", formattedStartTime, fades.fadeInSec, "videoStartTimeDisplay")}
        ${renderClipBoundFadeControl("out", "Clip Out", formattedEndTime, fades.fadeOutSec, "videoEndTimeDisplay")}
        <span class="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
          <span>Video Duration:</span>
          <span id="videoDurationDisplay" class="font-mono font-bold text-zinc-900 dark:text-white">${formattedDuration}</span>
        </span>
        ${generateCcBtnHtml}
      </div>
    `;
		const genBtnSolo = document.getElementById("generateCcBtn");
		if (genBtnSolo && typeof window.triggerVttGeneration === "function") {
			genBtnSolo.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				window.triggerVttGeneration();
			});
		}
		bindClipFadeFooterControls();
	} catch (error) {
		toConsole("updateVideoTimeSummary error", error.message, debuggin);
	}
};
window.updateVideoTimeSummary = updateVideoTimeSummary;
