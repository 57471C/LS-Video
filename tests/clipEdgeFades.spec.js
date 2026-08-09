import { describe, expect, it } from "vitest";

import {
	clampFadeSec,
	computeClipEdgeFadeGain,
	computeClipFadeZoneRanges,
	fadeOutEarlyBlackSec,
	FADE_DEFAULT_SEC,
	FADE_HARD_MAX_SEC,
	formatFadeBadge,
	normalizeFadeSec,
} from "../ui/app.js";

describe("clip-edge fade helpers", () => {
	it("defaults clip-edge fade duration to 0 (no fade)", () => {
		expect(FADE_DEFAULT_SEC).toBe(0);
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

	describe("computeClipEdgeFadeGain", () => {
		it("ramps 0→1 over fade-in after clipIn", () => {
			// clip 10..40, fade in 2s
			expect(computeClipEdgeFadeGain(10, 10, 40, 2, 0)).toBe(0);
			expect(computeClipEdgeFadeGain(11, 10, 40, 2, 0)).toBeCloseTo(0.5, 5);
			expect(computeClipEdgeFadeGain(12, 10, 40, 2, 0)).toBe(1);
			expect(computeClipEdgeFadeGain(20, 10, 40, 2, 0)).toBe(1);
		});

		it("ramps 1→0 over fade-out and is solid black before clipOut", () => {
			// early black = min(0.08, 2*0.2, 15) = 0.08 → blackAt = 39.92
			const early = fadeOutEarlyBlackSec(2, 30);
			expect(early).toBeCloseTo(0.08, 5);
			const blackAt = 40 - early;
			const startOut = blackAt - 2;
			expect(computeClipEdgeFadeGain(startOut - 0.01, 10, 40, 0, 2)).toBe(1);
			// Mid-ramp (linear into blackAt, not into outT)
			const mid = (startOut + blackAt) / 2;
			expect(computeClipEdgeFadeGain(mid, 10, 40, 0, 2)).toBeCloseTo(0.5, 5);
			// Fully black slightly before cut
			expect(computeClipEdgeFadeGain(blackAt, 10, 40, 0, 2)).toBe(0);
			expect(computeClipEdgeFadeGain(39.95, 10, 40, 0, 2)).toBe(0);
			expect(computeClipEdgeFadeGain(40, 10, 40, 0, 2)).toBe(0);
		});

		it("is full outside fade zones and zero outside clip", () => {
			expect(computeClipEdgeFadeGain(9, 10, 40, 1, 1)).toBe(0);
			expect(computeClipEdgeFadeGain(25, 10, 40, 1, 1)).toBe(1);
			expect(computeClipEdgeFadeGain(41, 10, 40, 1, 1)).toBe(0);
		});
	});

	describe("computeClipFadeZoneRanges", () => {
		it("fade-in is [clipIn, clipIn+fi]; fade-out ends at early black ≤ clipOut", () => {
			const r = computeClipFadeZoneRanges(0, 9, 2, 1);
			expect(r.fadeIn).toEqual({ start: 0, end: 2 });
			const early = fadeOutEarlyBlackSec(1, 9);
			const blackAt = 9 - early;
			// Must be LEFT of out, and finish solid black before the cut
			expect(r.fadeOut.start).toBeCloseTo(blackAt - 1, 5);
			expect(r.fadeOut.end).toBeCloseTo(blackAt, 5);
			expect(r.fadeOut.end).toBeLessThanOrEqual(9);
			expect(r.fadeOut.start).toBeLessThan(r.fadeOut.end);
		});

		it("never places fade-out starting at clipOut (right side / grey tail)", () => {
			const r = computeClipFadeZoneRanges(0, 9, 0, 1);
			const early = fadeOutEarlyBlackSec(1, 9);
			expect(r.fadeOut.start).toBeCloseTo(9 - early - 1, 5);
			expect(r.fadeOut.end).toBeCloseTo(9 - early, 5);
			expect(r.fadeOut.start).not.toBe(9);
			expect(r.fadeOut.end).toBeLessThan(9);
		});

		it("clamps fades to active duration and clears zeros", () => {
			const r = computeClipFadeZoneRanges(10, 20, 0, 0);
			expect(r.fadeIn).toBeNull();
			expect(r.fadeOut).toBeNull();
			const long = computeClipFadeZoneRanges(0, 4, 10, 10);
			expect(long.fadeIn).toEqual({ start: 0, end: 4 });
			// full-span out when fo >= active; early black still ≤ clipOut
			const early = fadeOutEarlyBlackSec(4, 4);
			expect(long.fadeOut.start).toBe(0);
			expect(long.fadeOut.end).toBeCloseTo(4 - early, 5);
		});
	});
});
