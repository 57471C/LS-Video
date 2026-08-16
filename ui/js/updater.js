/**
 * LS.Video auto-update (speedDF-style UX).
 *
 * Toast: Cancel | Now | When I close
 * - Now → downloadAndInstall + relaunch
 * - When I close → background download, install on window close
 *
 * Uses withGlobalTauri surfaces: window.__TAURI__.updater / .process / .window
 * Silent no-op outside the desktop shell or when already on latest.
 */

const UPDATE_TOAST_ID = "lsvideo-update-toast";
const DOWNLOAD_TOAST_ID = "lsvideo-update-download-toast";

/** @type {any} */
let availableUpdate = null;
/** @type {any} */
let pendingUpdateRef = null;
let isUpdateReadyToInstall = false;
let isDownloadingUpdate = false;
let isApplyingDeferredUpdate = false;
let closeGuardAttached = false;

function getUpdaterApi() {
	const t = window.__TAURI__;
	if (!t) return null;
	return t.updater || null;
}

function getProcessApi() {
	const t = window.__TAURI__;
	if (!t) return null;
	return t.process || null;
}

function getAppWindow() {
	const t = window.__TAURI__;
	if (!t?.window) return null;
	try {
		if (typeof t.window.getCurrentWindow === "function") {
			return t.window.getCurrentWindow();
		}
	} catch {
		/* ignore */
	}
	return t.window.appWindow || null;
}

function removeEl(id) {
	document.getElementById(id)?.remove();
}

function hostContainer() {
	let host = document.getElementById("toastContainer");
	if (!host) {
		host = document.createElement("div");
		host.id = "toastContainer";
		host.className =
			"fixed z-[9999] flex flex-col gap-2 w-full max-w-md pointer-events-none px-4 items-end";
		host.style.cssText =
			"top: auto !important; bottom: 1.5rem !important; left: auto !important; right: 1.5rem !important;";
		document.body.appendChild(host);
	}
	return host;
}

function notify(message, type = "info") {
	if (typeof window.showToast === "function") {
		window.showToast(message, type);
	} else {
		console.log(`[Updater] ${message}`);
	}
}

function showUpdateToast(update) {
	removeEl(UPDATE_TOAST_ID);
	const host = hostContainer();
	const version = update?.version || "?";

	const card = document.createElement("div");
	card.id = UPDATE_TOAST_ID;
	card.className =
		"pointer-events-auto max-w-sm w-full rounded-xl border shadow-2xl p-4 flex flex-col gap-3 bg-white/95 dark:bg-slate-900/95 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100";
	card.innerHTML = `
    <div class="flex items-start gap-3">
      <div class="flex h-8 w-8 shrink-0 rounded-lg items-center justify-center text-sm bg-cyan-500/15 text-cyan-600 dark:text-cyan-400">⚡</div>
      <div class="flex flex-col min-w-0">
        <p class="text-[12px] font-bold uppercase tracking-wider">Update Available</p>
        <p class="text-[10px] font-medium mt-1 leading-normal text-slate-500 dark:text-slate-400">
          LS.Video v${version} is ready to install.
        </p>
      </div>
    </div>
    <div class="flex gap-2 justify-end flex-wrap">
      <button type="button" data-act="cancel"
        class="px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer">
        Cancel
      </button>
      <button type="button" data-act="now"
        class="px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider bg-cyan-600 hover:bg-cyan-500 text-white cursor-pointer">
        Now
      </button>
      <button type="button" data-act="later"
        class="px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer">
        When I close
      </button>
    </div>
  `;

	card.querySelector('[data-act="cancel"]')?.addEventListener("click", () => {
		removeEl(UPDATE_TOAST_ID);
		availableUpdate = null;
	});

	card.querySelector('[data-act="now"]')?.addEventListener("click", () => {
		void installNow(update);
	});

	card.querySelector('[data-act="later"]')?.addEventListener("click", () => {
		void downloadForLater(update);
	});

	host.appendChild(card);
}

function showDownloadProgress(pct) {
	let card = document.getElementById(DOWNLOAD_TOAST_ID);
	if (!card) {
		const host = hostContainer();
		card = document.createElement("div");
		card.id = DOWNLOAD_TOAST_ID;
		card.className =
			"pointer-events-auto w-64 rounded-xl border shadow-2xl p-4 flex flex-col gap-2 bg-white/95 dark:bg-slate-900/95 border-slate-200 dark:border-slate-700";
		card.innerHTML = `
      <p class="text-[12px] font-bold uppercase tracking-wider text-slate-800 dark:text-slate-100">Downloading Update</p>
      <div class="h-1.5 w-full rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700">
        <div data-bar class="h-full bg-cyan-500 transition-all duration-300" style="width:0%"></div>
      </div>
      <p data-pct class="text-[10px] font-medium text-right text-slate-500">0%</p>
    `;
		host.appendChild(card);
	}
	const bar = card.querySelector("[data-bar]");
	const label = card.querySelector("[data-pct]");
	if (bar) bar.style.width = `${pct}%`;
	if (label) label.textContent = `${pct}%`;
}

async function installNow(update) {
	removeEl(UPDATE_TOAST_ID);
	availableUpdate = null;
	notify("Applying update and relaunching…", "info");
	try {
		if (typeof update.downloadAndInstall === "function") {
			await update.downloadAndInstall();
		} else {
			await update.download();
			await update.install();
		}
		const proc = getProcessApi();
		if (proc?.relaunch) {
			await proc.relaunch();
		} else {
			notify("Update installed — please restart LS.Video.", "success");
		}
	} catch (err) {
		console.error("[Updater] install now failed:", err);
		notify("Update failed", "error");
	}
}

async function downloadForLater(update) {
	removeEl(UPDATE_TOAST_ID);
	availableUpdate = null;
	if (isDownloadingUpdate) return;
	isDownloadingUpdate = true;
	notify("Downloading update in background…", "info");
	showDownloadProgress(0);

	try {
		let contentLength = 0;
		let downloaded = 0;

		await update.download((event) => {
			if (!event) return;
			const kind = event.event || event;
			if (kind === "Started" || event.event === "Started") {
				contentLength = event.data?.contentLength || 0;
				downloaded = 0;
				showDownloadProgress(0);
			} else if (kind === "Progress" || event.event === "Progress") {
				downloaded += event.data?.chunkLength || 0;
				if (contentLength > 0) {
					showDownloadProgress(
						Math.min(100, Math.round((downloaded / contentLength) * 100)),
					);
				}
			} else if (kind === "Finished" || event.event === "Finished") {
				showDownloadProgress(100);
			}
		});

		pendingUpdateRef = update;
		isUpdateReadyToInstall = true;
		isDownloadingUpdate = false;
		removeEl(DOWNLOAD_TOAST_ID);
		notify("Update ready — will install when you close.", "success");
		attachCloseGuard();
	} catch (err) {
		console.error("[Updater] background download failed:", err);
		isDownloadingUpdate = false;
		pendingUpdateRef = null;
		isUpdateReadyToInstall = false;
		removeEl(DOWNLOAD_TOAST_ID);
		notify("Update download failed", "error");
	}
}

function attachCloseGuard() {
	if (closeGuardAttached) return;
	const appWindow = getAppWindow();
	if (!appWindow || typeof appWindow.onCloseRequested !== "function") return;

	closeGuardAttached = true;
	appWindow.onCloseRequested(async (event) => {
		if (!isUpdateReadyToInstall || !pendingUpdateRef) return;

		isUpdateReadyToInstall = false;
		const updateRef = pendingUpdateRef;
		pendingUpdateRef = null;
		isApplyingDeferredUpdate = true;

		try {
			event.preventDefault();
		} catch {
			/* some platforms */
		}

		try {
			showApplyingOverlay();
			await updateRef.install();
			const proc = getProcessApi();
			if (proc?.relaunch) {
				await proc.relaunch();
			} else {
				await appWindow.close();
			}
		} catch (err) {
			console.error("[Updater] deferred install failed:", err);
			isApplyingDeferredUpdate = false;
			hideApplyingOverlay();
			notify("Update install failed", "error");
		}
	});
}

function showApplyingOverlay() {
	if (document.getElementById("lsvideo-update-applying")) return;
	const el = document.createElement("div");
	el.id = "lsvideo-update-applying";
	el.className =
		"fixed inset-0 z-[10000] bg-black/80 flex flex-col items-center justify-center gap-3";
	el.innerHTML = `
    <div class="w-10 h-10 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin"></div>
    <p class="text-sm font-semibold text-slate-200 tracking-wide uppercase">Installing update…</p>
  `;
	document.body.appendChild(el);
}

function hideApplyingOverlay() {
	document.getElementById("lsvideo-update-applying")?.remove();
}

/**
 * Run a background update check. Safe to call multiple times; no-ops in browser.
 * @param {{ force?: boolean }} [opts]
 */
export async function checkForApplicationUpdates(opts = {}) {
	if (!window.__TAURI__) return;
	if (isDownloadingUpdate || isApplyingDeferredUpdate) return;

	// Optional preference (localStorage). Default: check on.
	if (!opts.force) {
		const pref = localStorage.getItem("lsvideo_check_updates_on_launch");
		if (pref === "0" || pref === "false") {
			console.log("[Updater] check skipped (disabled in preference)");
			return;
		}
	}

	const updater = getUpdaterApi();
	if (!updater || typeof updater.check !== "function") {
		console.warn("[Updater] plugin API not available on window.__TAURI__.updater");
		return;
	}

	try {
		const update = await updater.check();
		if (!update) return;

		const version = update.version;
		if (!version) return;

		const isCritical =
			update.rawJson?.critical ||
			update.rawJson?.forced ||
			update.rawJson?.critical === true;

		if (isCritical) {
			notify(`Critical update v${version} — installing…`, "info");
			await installNow(update);
			return;
		}

		availableUpdate = update;
		showUpdateToast(update);
	} catch (err) {
		console.warn("[Updater] background check:", err);
	}
}

/** Manual “Check for updates” from settings/help. */
export async function checkForUpdatesNow() {
	await checkForApplicationUpdates({ force: true });
}

/**
 * Call once after DOM is ready (desktop shell only).
 */
export function initUpdater() {
	if (!window.__TAURI__) return;
	setTimeout(() => {
		void checkForApplicationUpdates();
	}, 2500);
}

window.checkForUpdatesNow = checkForUpdatesNow;
window.initUpdater = initUpdater;
