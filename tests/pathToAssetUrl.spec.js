import { afterEach, describe, expect, it, vi } from "vitest";
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
	vi.restoreAllMocks();
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

	it("macOS ignores convertFileSrc and always uses encodeURIComponent", () => {
		const convertFileSrc = vi.fn(() => "asset://localhost/%6FVolumes%6Fbad.mp4");
		window.__TAURI__ = { core: { convertFileSrc } };
		setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
		const path = "/Volumes/TV/Justice Leauge/clip.mp4";
		const url = pathToAssetUrl(path);
		expect(convertFileSrc).not.toHaveBeenCalled();
		expect(url).toBe(`asset://localhost/${encodeURIComponent(path)}`);
		expect(url).toContain("%2F");
		expect(url).toContain("%20");
		expect(url).not.toMatch(/%6[Ff]/);
	});

	it("macOS uses asset://localhost when convertFileSrc is missing", () => {
		window.__TAURI__ = {};
		setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
		const path = "/Users/me/My Video.mp4";
		expect(pathToAssetUrl(path)).toBe(
			`asset://localhost/${encodeURIComponent(path)}`,
		);
		expect(pathToAssetUrl(path)).toContain("%2F");
		expect(pathToAssetUrl(path)).toContain("%20");
	});

	it("Windows prefers core.convertFileSrc when present and sane", () => {
		setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		window.__TAURI__ = {
			core: {
				convertFileSrc: (p) =>
					`https://asset.localhost/${encodeURIComponent(p)}`,
			},
		};
		const path = "C:\\Videos\\file.mp4";
		expect(pathToAssetUrl(path)).toBe(
			`https://asset.localhost/${encodeURIComponent(path)}`,
		);
	});

	it("Windows falls back to tauri.convertFileSrc when core is missing and sane", () => {
		setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		window.__TAURI__ = {
			tauri: {
				convertFileSrc: (p) =>
					`https://asset.localhost/${encodeURIComponent(p)}`,
			},
		};
		const path = "C:\\Videos\\file.mp4";
		expect(pathToAssetUrl(path)).toBe(
			`https://asset.localhost/${encodeURIComponent(path)}`,
		);
	});

	it("Windows rejects native URLs that encode separators as %6F", () => {
		setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		window.__TAURI__ = {
			core: {
				convertFileSrc: () =>
					"https://asset.localhost/%6FC%6FVideos%6Ffile.mp4",
			},
		};
		const path = "C:\\Videos\\file.mp4";
		const url = pathToAssetUrl(path);
		expect(url).toBe(`https://asset.localhost/${encodeURIComponent(path)}`);
		expect(url).not.toMatch(/%6[Ff]/);
	});

	it("Windows uses https://asset.localhost when convertFileSrc is missing", () => {
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
