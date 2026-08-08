import { describe, expect, it } from "vitest";

import {
	buildSpeedRanges,
	clampSpeedValue,
	formatSpeedBadge,
	getActiveSpeedMarker,
	SPEED_DEFAULT,
	SPEED_MAX,
	SPEED_MIN,
} from "../ui/app.js";

describe("Speed marker helpers", () => {
	it("clamps speed to 0.25–4", () => {
		expect(clampSpeedValue(0.1)).toBe(SPEED_MIN);
		expect(clampSpeedValue(10)).toBe(SPEED_MAX);
		expect(clampSpeedValue(1.5)).toBe(1.5);
		expect(clampSpeedValue("2")).toBe(2);
		expect(clampSpeedValue(null)).toBe(SPEED_DEFAULT);
	});

	it("formats badge text", () => {
		expect(formatSpeedBadge(2)).toBe("2x");
		expect(formatSpeedBadge(1.5)).toBe("1.5x");
		expect(formatSpeedBadge(0.5)).toBe("0.5x");
	});

	it("getActiveSpeedMarker picks latest speed <= time", () => {
		const markers = [
			{ type: "speed", startTime: 0, speedValue: 2 },
			{ type: "speed", startTime: 5, speedValue: 1 },
			{ type: "standard", startTime: 3 },
		];
		expect(getActiveSpeedMarker(markers, 0, 0, 20)?.rate).toBe(2);
		expect(getActiveSpeedMarker(markers, 2, 0, 20)?.rate).toBe(2);
		expect(getActiveSpeedMarker(markers, 5, 0, 20)?.rate).toBe(1);
		expect(getActiveSpeedMarker(markers, 10, 0, 20)?.rate).toBe(1);
		expect(getActiveSpeedMarker(markers, -1, 0, 20)).toBeNull();
	});

	it("buildSpeedRanges splits on Speed markers (gap before first = 1x)", () => {
		const markers = [
			{ type: "speed", startTime: 0, speedValue: 2 },
			{ type: "speed", startTime: 5, speedValue: 1 },
		];
		const ranges = buildSpeedRanges(markers, 0, 10);
		expect(ranges).toEqual([
			{ start: 0, end: 5, rate: 2 },
			{ start: 5, end: 10, rate: 1 },
		]);
		// Output duration should be 5/2 + 5/1 = 7.5
		const outDur = ranges.reduce((s, r) => s + (r.end - r.start) / r.rate, 0);
		expect(outDur).toBeCloseTo(7.5, 5);
	});

	it("buildSpeedRanges uses 1x until first speed when not at clipIn", () => {
		const markers = [{ type: "speed", startTime: 3, speedValue: 2 }];
		expect(buildSpeedRanges(markers, 0, 10)).toEqual([
			{ start: 0, end: 3, rate: 1 },
			{ start: 3, end: 10, rate: 2 },
		]);
	});
});
