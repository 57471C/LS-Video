import { describe, expect, it } from "vitest";

import {
	buildWebVttFromCues,
	collectBatchExportCaptionCues,
	formatVttTimestamp,
	parseVttTimestamp,
	shiftWebVttForTrim,
} from "../ui/app.js";

describe("batch export WebVTT helpers", () => {
	describe("formatVttTimestamp / parseVttTimestamp", () => {
		it("round-trips HH:MM:SS.mmm", () => {
			expect(formatVttTimestamp(0)).toBe("00:00:00.000");
			expect(formatVttTimestamp(65.5)).toBe("00:01:05.500");
			expect(parseVttTimestamp("00:01:05.500")).toBeCloseTo(65.5, 3);
			expect(parseVttTimestamp("01:05.500")).toBeCloseTo(65.5, 3);
		});
	});

	describe("buildWebVttFromCues", () => {
		it("uses next cue start as end; last cue holds +3s clamped to endLimit", () => {
			const vtt = buildWebVttFromCues(
				[
					{ start: 1, name: "A" },
					{ start: 4, name: "B" },
				],
				10,
			);
			expect(vtt).toContain("WEBVTT");
			expect(vtt).toContain("00:00:01.000 --> 00:00:04.000");
			expect(vtt).toContain("A");
			expect(vtt).toContain("00:00:04.000 --> 00:00:07.000");
			expect(vtt).toContain("B");
		});

		it("returns null for empty cues", () => {
			expect(buildWebVttFromCues([])).toBeNull();
		});
	});

	describe("collectBatchExportCaptionCues — solo", () => {
		it("no markers → empty cues (video-only; no crash)", () => {
			const queue = [
				{
					videoFilePath: "C:/vids/solo.mp4",
					appState: { markers: [] },
				},
			];
			const job = {
				multi: false,
				indices: [0],
				segments: [
					{
						path: "C:/vids/solo.mp4",
						start_time: 0,
						end_time: 30,
						queueIndex: 0,
					},
				],
			};
			const { cues, hasMarkers } = collectBatchExportCaptionCues(job, queue);
			expect(hasMarkers).toBe(false);
			expect(cues).toEqual([]);
			expect(buildWebVttFromCues(cues)).toBeNull();
			// Missing queue / empty job must not throw
			expect(() =>
				collectBatchExportCaptionCues(
					{ multi: false, indices: [], segments: [] },
					[],
				),
			).not.toThrow();
			expect(() => collectBatchExportCaptionCues(null, null)).not.toThrow();
		});

		it("shifts marker times relative to clipIn (export t=0)", () => {
			const queue = [
				{
					videoFilePath: "C:/vids/solo.mp4",
					clipInTime: 10,
					clipOutTime: 40,
					appState: {
						markers: [
							{ startTime: 5, name: "before-trim" },
							{ startTime: 12, name: "First" },
							{ startTime: 20, name: "Second" },
							{ startTime: 50, name: "after-trim" },
						],
					},
				},
			];
			const job = {
				multi: false,
				indices: [0],
				segments: [
					{
						path: "C:/vids/solo.mp4",
						start_time: 10,
						end_time: 40,
						queueIndex: 0,
					},
				],
			};
			const { cues, endLimit, hasMarkers } = collectBatchExportCaptionCues(
				job,
				queue,
			);
			expect(hasMarkers).toBe(true);
			expect(endLimit).toBe(30);
			expect(cues).toEqual([
				{ start: 2, name: "First" },
				{ start: 10, name: "Second" },
			]);
			const vtt = buildWebVttFromCues(cues, endLimit);
			expect(vtt).toContain("00:00:02.000 --> 00:00:10.000");
			expect(vtt).toContain("First");
			expect(vtt).toContain("00:00:10.000 --> 00:00:13.000");
			expect(vtt).toContain("Second");
		});
	});

	describe("collectBatchExportCaptionCues — join 1–2", () => {
		it("offsets second-clip markers by first segment duration", () => {
			// Clip A: 0–10s export (markers at 2, 8)
			// Clip B: 5–15s source → 10s duration (markers at 7, 12 → rel 2, 7)
			// Sequence: A markers at 2, 8; B at 10+2=12, 10+7=17
			const queue = [
				{
					videoFilePath: "C:/vids/a.mp4",
					appState: {
						markers: [
							{ startTime: 2, name: "A1" },
							{ startTime: 8, name: "A2" },
						],
					},
				},
				{
					videoFilePath: "C:/vids/b.mp4",
					appState: {
						markers: [
							{ startTime: 7, name: "B1" },
							{ startTime: 12, name: "B2" },
						],
					},
				},
			];
			const job = {
				multi: true,
				indices: [0, 1],
				segments: [
					{
						path: "C:/vids/a.mp4",
						start_time: 0,
						end_time: 10,
						queueIndex: 0,
					},
					{
						path: "C:/vids/b.mp4",
						start_time: 5,
						end_time: 15,
						queueIndex: 1,
					},
				],
			};
			const { cues, endLimit, hasMarkers } = collectBatchExportCaptionCues(
				job,
				queue,
			);
			expect(hasMarkers).toBe(true);
			expect(endLimit).toBe(20);
			expect(cues.map((c) => ({ start: c.start, name: c.name }))).toEqual([
				{ start: 2, name: "A1" },
				{ start: 8, name: "A2" },
				{ start: 12, name: "B1" },
				{ start: 17, name: "B2" },
			]);
			const vtt = buildWebVttFromCues(cues, endLimit);
			expect(vtt).toContain("00:00:02.000 --> 00:00:08.000");
			expect(vtt).toContain("A1");
			expect(vtt).toContain("00:00:12.000 --> 00:00:17.000");
			expect(vtt).toContain("B1");
			expect(vtt).toContain("00:00:17.000 --> 00:00:20.000");
			expect(vtt).toContain("B2");
		});
	});

	describe("shiftWebVttForTrim", () => {
		it("shifts existing VTT onto export trim timeline", () => {
			const source = `WEBVTT

00:00:08.000 --> 00:00:11.000
Hello

00:00:15.000 --> 00:00:18.000
World
`;
			const shifted = shiftWebVttForTrim(source, 10, 40);
			expect(shifted).toContain("00:00:00.000 --> 00:00:01.000");
			expect(shifted).toContain("Hello");
			expect(shifted).toContain("00:00:05.000 --> 00:00:08.000");
			expect(shifted).toContain("World");
		});

		it("drops cues entirely outside the trim", () => {
			const source = `WEBVTT

00:00:01.000 --> 00:00:02.000
Too early
`;
			expect(shiftWebVttForTrim(source, 10, 40)).toBeNull();
		});
	});
});
