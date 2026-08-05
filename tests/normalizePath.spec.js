import { describe, expect, it } from "vitest";
import { normalizePath } from "../ui/app.js";

describe("normalizePath", () => {
	it("should preserve standard UNC network share paths", () => {
		const uncPath = "\\\\ntone\\data\\videos\\file.mp4";
		expect(normalizePath(uncPath)).toBe("\\\\ntone\\data\\videos\\file.mp4");
	});

	it("should strip extended UNC prefix \\\\?\\UNC\\ and return standard UNC path", () => {
		const extendedUnc = "\\\\?\\UNC\\ntone\\data\\videos\\file.mp4";
		expect(normalizePath(extendedUnc)).toBe("\\\\ntone\\data\\videos\\file.mp4");
	});

	it("should strip extended local prefix \\\\?\\ and return standard drive path", () => {
		const extendedLocal = "\\\\?\\C:\\Videos\\file.mp4";
		expect(normalizePath(extendedLocal)).toBe("C:\\Videos\\file.mp4");
	});

	it("should preserve standard local drive paths", () => {
		const localPath = "C:\\Videos\\file.mp4";
		expect(normalizePath(localPath)).toBe("C:\\Videos\\file.mp4");
	});

	it("should handle forward slash extended paths gracefully", () => {
		const fwdUnc = "//?/UNC/ntone/data/videos/file.mp4";
		expect(normalizePath(fwdUnc)).toBe("//ntone/data/videos/file.mp4");

		const fwdLocal = "//?/C:/Videos/file.mp4";
		expect(normalizePath(fwdLocal)).toBe("C:/Videos/file.mp4");
	});

	it("should handle empty or non-string inputs safely", () => {
		expect(normalizePath("")).toBe("");
		expect(normalizePath(null)).toBe(null);
		expect(normalizePath(undefined)).toBe(undefined);
	});
});
