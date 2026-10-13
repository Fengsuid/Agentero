import { describe, expect, it } from "vitest";
import { placeAnchoredPopover } from "@/components/agent/composer/anchored-popover";

describe("placeAnchoredPopover", () => {
	it("shifts a card left until its right edge meets the window", () => {
		const placed = placeAnchoredPopover(
			{ left: 800, top: 100, bottom: 120 },
			{ width: 448, viewportWidth: 1000, placeBelow: false },
		);
		expect(placed.width).toBe(448);
		expect(placed.left + placed.width).toBe(992);
		expect(placed.top).toBe(94);
		expect(placed.transform).toBe("translateY(-100%)");
	});

	it("leaves a card that already fits on the anchor", () => {
		const placed = placeAnchoredPopover(
			{ left: 40, top: 400, bottom: 420 },
			{ width: 448, viewportWidth: 1200, placeBelow: true },
		);
		expect(placed.left).toBe(40);
		expect(placed.top).toBe(426);
		expect(placed.width).toBe(448);
		expect(placed.transform).toBeUndefined();
	});

	it("shrinks a card that is wider than the window", () => {
		const placed = placeAnchoredPopover(
			{ left: 0, top: 10, bottom: 30 },
			{ width: 448, viewportWidth: 200, placeBelow: true },
		);
		expect(placed.width).toBe(184);
		expect(placed.left).toBe(8);
		expect(placed.left + placed.width).toBe(192);
	});
});
