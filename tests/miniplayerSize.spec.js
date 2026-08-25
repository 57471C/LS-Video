import { describe, it, expect, beforeEach, vi } from "vitest";

describe("miniplayer size persistence", () => {
	const MINIPLAYER_DEFAULT_WIDTH = 580;
	const MINIPLAYER_DEFAULT_HEIGHT = 524;
	const MINIPLAYER_MIN_WIDTH = 320;
	const MINIPLAYER_MIN_HEIGHT = 200;
	const MINIPLAYER_STORAGE_KEY_W = "lsvideo_miniplayer_w";
	const MINIPLAYER_STORAGE_KEY_H = "lsvideo_miniplayer_h";

	const getSavedMiniplayerSize = () => {
		let w = Number.parseInt(localStorage.getItem(MINIPLAYER_STORAGE_KEY_W), 10);
		let h = Number.parseInt(localStorage.getItem(MINIPLAYER_STORAGE_KEY_H), 10);
		if (!Number.isFinite(w) || w <= 0) {
			w = MINIPLAYER_DEFAULT_WIDTH;
		}
		if (!Number.isFinite(h) || h <= 0) {
			h = MINIPLAYER_DEFAULT_HEIGHT;
		}
		return {
			width: Math.max(MINIPLAYER_MIN_WIDTH, w),
			height: Math.max(MINIPLAYER_MIN_HEIGHT, h),
		};
	};

	const saveMiniplayerSize = (w, h) => {
		const currentW = w !== undefined ? w : window.innerWidth;
		const currentH = h !== undefined ? h : window.innerHeight;
		if (Number.isFinite(currentW) && currentW >= MINIPLAYER_MIN_WIDTH) {
			localStorage.setItem(
				MINIPLAYER_STORAGE_KEY_W,
				String(Math.round(currentW)),
			);
		}
		if (Number.isFinite(currentH) && currentH >= MINIPLAYER_MIN_HEIGHT) {
			localStorage.setItem(
				MINIPLAYER_STORAGE_KEY_H,
				String(Math.round(currentH)),
			);
		}
	};

	beforeEach(() => {
		localStorage.clear();
	});

	it("should return default dimensions (580x524) when keys are missing", () => {
		const size = getSavedMiniplayerSize();
		expect(size.width).toBe(580);
		expect(size.height).toBe(524);
	});

	it("should save and restore valid custom miniplayer dimensions", () => {
		saveMiniplayerSize(700, 480);
		const size = getSavedMiniplayerSize();
		expect(size.width).toBe(700);
		expect(size.height).toBe(480);
	});

	it("should clamp values below minimum constraints to 320x200", () => {
		localStorage.setItem(MINIPLAYER_STORAGE_KEY_W, "100");
		localStorage.setItem(MINIPLAYER_STORAGE_KEY_H, "150");
		const size = getSavedMiniplayerSize();
		expect(size.width).toBe(320);
		expect(size.height).toBe(200);
	});

	it("should handle corrupted or non-numeric localStorage values gracefully", () => {
		localStorage.setItem(MINIPLAYER_STORAGE_KEY_W, "invalid_num");
		localStorage.setItem(MINIPLAYER_STORAGE_KEY_H, "-50");
		const size = getSavedMiniplayerSize();
		expect(size.width).toBe(580);
		expect(size.height).toBe(524);
	});

	it("should not persist dimensions smaller than min bounds", () => {
		saveMiniplayerSize(200, 100);
		expect(localStorage.getItem(MINIPLAYER_STORAGE_KEY_W)).toBeNull();
		expect(localStorage.getItem(MINIPLAYER_STORAGE_KEY_H)).toBeNull();
	});
});
