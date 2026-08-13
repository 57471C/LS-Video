/**
 * Convert a filesystem path to a WebView-loadable asset URL.
 *
 * macOS / Linux: always use encodeURIComponent + asset://localhost/.
 * Native convertFileSrc is known to emit %6F path separators on some
 * Apple Silicon / WKWebView builds (media fails with MediaError 4).
 * Do not call it on Unix — field logs showed reject-based fallback never
 * firing even when the returned URL was clearly bad.
 *
 * Windows: prefer native convertFileSrc when present and sane; fall back
 * to https://asset.localhost/<encodeURIComponent> if missing, throws, or
 * returns the %6F separator pattern.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function pathToAssetUrl(filePath) {
	if (!filePath || typeof filePath !== "string") return filePath;
	if (!window.__TAURI__) return filePath;

	const isWin = /Windows/i.test(navigator.userAgent || "");
	const encoded = encodeURIComponent(filePath);
	const manual = isWin
		? `https://asset.localhost/${encoded}`
		: `asset://localhost/${encoded}`;

	// Unix (macOS/Linux): never trust convertFileSrc for path encoding.
	if (!isWin) {
		console.info(
			"[pathToAssetUrl] unix → encodeURIComponent",
			filePath,
			"→",
			manual,
		);
		return manual;
	}

	const convertFn =
		window.__TAURI__.core?.convertFileSrc ||
		window.__TAURI__.tauri?.convertFileSrc;
	if (typeof convertFn !== "function") {
		console.info("[pathToAssetUrl] win → manual (no convertFileSrc)", manual);
		return manual;
	}

	try {
		const native = convertFn(filePath);
		if (typeof native !== "string" || !native) {
			console.info("[pathToAssetUrl] win → manual (empty native)", manual);
			return manual;
		}
		// Safety net if Windows ever emits the Mac-style %6F bug
		const pathHasSep = /[/\\]/.test(filePath);
		const nativeHasBadO = /%6[Ff]/.test(native);
		const nativeHasGoodSlash = /%2[Ff]/.test(native);
		if (pathHasSep && nativeHasBadO && !nativeHasGoodSlash) {
			console.warn(
				"[pathToAssetUrl] native convertFileSrc returned suspicious URL; using encodeURIComponent fallback:",
				native,
			);
			return manual;
		}
		return native;
	} catch (err) {
		console.warn("[pathToAssetUrl] convertFileSrc threw; using fallback:", err);
		return manual;
	}
}
