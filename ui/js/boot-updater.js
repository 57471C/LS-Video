import { initUpdater } from "./updater.js";

window.addEventListener("load", () => {
	try {
		initUpdater();
	} catch (e) {
		console.warn("[Updater] init failed:", e);
	}
});
