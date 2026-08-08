import { describe, expect, it } from "vitest";

import {
	clampFadeSec,
	FADE_DEFAULT_SEC,
	FADE_HARD_MAX_SEC,
	formatFadeBadge,
	normalizeFadeSec,
} from "../ui/app.js";

describe("clip-edge fade helpers", () => {
	it("defaults first-set duration to 1.0s", () => {
		expect(FADE_DEFAULT_SEC).toBe(1.0);
	});

	it("normalizeFadeSec floors non-positive and keeps one decimal", () => {
		expect(normalizeFadeSec(0)).toBe(0);
		expect(normalizeFadeSec(-1)).toBe(0);
		expect(normalizeFadeSec("1.55")).toBe(1.6);
		expect(normalizeFadeSec(0.5)).toBe(0.5);
		expect(normalizeFadeSec(2)).toBe(2);
	});

	it("clampFadeSec respects hard max and half clip duration", () => {
		expect(clampFadeSec(1.0, 20)).toBe(1.0);
		expect(clampFadeSec(0.5, 20)).toBe(0.5);
		// Hard max 10s
		expect(clampFadeSec(12, 100)).toBe(FADE_HARD_MAX_SEC);
		// Half of short clip wins over hard max
		expect(clampFadeSec(5, 4)).toBe(2.0);
		expect(clampFadeSec(0, 10)).toBe(0);
	});

	it("formatFadeBadge shows #.#s only when fade > 0", () => {
		expect(formatFadeBadge(0)).toBe("");
		expect(formatFadeBadge(1)).toBe("1.0s");
		expect(formatFadeBadge(0.5)).toBe("0.5s");
		expect(formatFadeBadge(1.5)).toBe("1.5s");
	});
});
