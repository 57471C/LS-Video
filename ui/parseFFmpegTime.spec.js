import { describe, expect, it } from "vitest";

import { parseFFmpegTime } from "./app.js";

describe("parseFFmpegTime", () => {
	it("should extract time and update progress bar correctly", () => {
		const progressBar = { value: 0 };
		const totalSeconds = 100;
		const line =
			"frame= 1000 fps= 30 q=28.0 size= 2048kB time=00:00:50.50 bitrate= 300.0kbits/s speed= 1.5x";

		parseFFmpegTime(line, totalSeconds, progressBar);

		expect(progressBar.value).toBe(50); // 50.5 seconds out of 100 seconds = 50%
	});

	it("should handle zero total seconds gracefully", () => {
		const progressBar = { value: 0 };
		const totalSeconds = 0;
		const line = "time=00:00:50.50";

		parseFFmpegTime(line, totalSeconds, progressBar);

		expect(progressBar.value).toBe(0);
	});

	it("should not throw if progressBar is not provided", () => {
		const totalSeconds = 100;
		const line = "time=00:00:50.50";

		expect(() => {
			parseFFmpegTime(line, totalSeconds, undefined);
		}).not.toThrow();
	});

	it("should not update if line does not contain time string", () => {
		const progressBar = { value: 0 };
		const totalSeconds = 100;
		const line =
			"frame= 1000 fps= 30 q=28.0 size= 2048kB bitrate= 300.0kbits/s speed= 1.5x";

		parseFFmpegTime(line, totalSeconds, progressBar);

		expect(progressBar.value).toBe(0);
	});

	it("should clamp percentage to 100 max", () => {
		const progressBar = { value: 0 };
		const totalSeconds = 10;
		const line = "time=00:00:50.50"; // 50 seconds / 10 seconds = 500% -> clamp to 100%

		parseFFmpegTime(line, totalSeconds, progressBar);

		expect(progressBar.value).toBe(100);
	});

	it("should clamp percentage to 0 min", () => {
		// Technically negative time isn't in regex, but we check anyway if there's any weird parse
		const progressBar = { value: 50 };
		const totalSeconds = 10;
		const line = "time=00:00:00.00"; // 0 seconds / 10 seconds = 0% -> clamp to 0%

		parseFFmpegTime(line, totalSeconds, progressBar);

		expect(progressBar.value).toBe(0);
	});
});
