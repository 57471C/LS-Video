import { afterEach, describe, expect, it } from "vitest";
import { pathToAssetUrl } from "../ui/app.js";

const originalTauri = globalThis.window?.__TAURI__;
const originalUserAgent = navigator.userAgent;

const setUserAgent = (ua) => {
	Object.defineProperty(window.navigator, "userAgent", {
		value: ua,
		configurable: true,
	});
};

afterEach(() => {
	if (originalTauri === undefined) {
		delete window.__TAURI__;
	} else {
		window.__TAURI__ = originalTauri;
	}
	setUserAgent(originalUserAgent);
});

describe("pathToAssetUrl", () => {
	it("returns non-string and empty inputs unchanged", () => {
		expect(pathToAssetUrl("")).toBe("");
		expect(pathToAssetUrl(null)).toBe(null);
		expect(pathToAssetUrl(undefined)).toBe(undefined);
	});

	it("returns the raw path when Tauri is not available", () => {
		delete window.__TAURI__;
		expect(pathToAssetUrl("/Users/me/clip.mp4")).toBe("/Users/me/clip.mp4");
	});

	it("prefers core.convertFileSrc when present", () => {
		window.__TAURI__ = {
			core: {
				convertFileSrc: (p) => `converted-core:${p}`,
			},
		};
		expect(pathToAssetUrl("/Users/me/clip.mp4")).toBe(
			"converted-core:/Users/me/clip.mp4",
		);
	});

	it("falls back to tauri.convertFileSrc when core is missing", () => {
		window.__TAURI__ = {
			tauri: {
				convertFileSrc: (p) => `converted-tauri:${p}`,
			},
		};
		expect(pathToAssetUrl("C:\\Videos\\file.mp4")).toBe(
			"converted-tauri:C:\\Videos\\file.mp4",
		);
	});

	it("uses asset:// + encodeURIComponent on macOS when convertFileSrc is missing", () => {
		window.__TAURI__ = {};
		setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
		const path = "/Users/me/My Video.mp4";
		expect(pathToAssetUrl(path)).toBe(`asset://${encodeURIComponent(path)}`);
		expect(pathToAssetUrl(path)).toContain("%2F");
		expect(pathToAssetUrl(path)).toContain("%20");
	});

	it("uses https://asset.localhost/ + encodeURIComponent on Windows when convertFileSrc is missing", () => {
		window.__TAURI__ = {};
		setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		const path = "C:\\Videos\\file.mp4";
		expect(pathToAssetUrl(path)).toBe(
			`https://asset.localhost/${encodeURIComponent(path)}`,
		);
	});

	it("preserves UNC paths in the encoded fallback (does not strip leading slashes)", () => {
		window.__TAURI__ = {};
		setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		const uncPath = "\\\\ntone\\data\\videos\\file.mp4";
		const url = pathToAssetUrl(uncPath);
		expect(url).toBe(
			`https://asset.localhost/${encodeURIComponent(uncPath)}`,
		);
		expect(url).toContain(encodeURIComponent("\\\\ntone"));
	});
});
