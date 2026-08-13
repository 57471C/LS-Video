/**
 * Convert a filesystem path to a WebView-loadable asset URL.
 *
 * Prefer Tauri native convertFileSrc when it returns a sane URL (correct %2F
 * path encoding). If native is missing or returns the known-bad %6F separator
 * encoding seen on some macOS builds, fall back to encodeURIComponent with the
 * modern host forms:
 *   macOS/Linux: asset://localhost/<encoded>
 *   Windows:     https://asset.localhost/<encoded>
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

	const convertFn =
		window.__TAURI__.core?.convertFileSrc ||
		window.__TAURI__.tauri?.convertFileSrc;
	if (typeof convertFn !== "function") {
		return manual;
	}

	try {
		const native = convertFn(filePath);
		if (typeof native !== "string" || !native) {
			return manual;
		}
		// Reject the Mac bug pattern: path separators encoded as %6F (letter "o")
		// instead of %2F. Also reject absolute Unix paths that lack any %2F while
		// still containing %6F encodings.
		const hasBadSep =
			/%6[Ff](?:Volumes|Users|home|tmp|private|Applications)/i.test(native) ||
			(filePath.startsWith("/") &&
				/%6[Ff]/.test(native) &&
				!/%2[Ff]/.test(native));
		if (hasBadSep) {
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
