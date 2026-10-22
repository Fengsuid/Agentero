import { describe, expect, it } from "vitest";
import {
	syncTexClickPoint,
	syncTexHighlightBox,
} from "@/lib/tex/synctex-geometry";

describe("SyncTeX PDF coordinates", () => {
	it.each([
		[0, 600, 800, 200, 150],
		[1, 800, 600, 150, 600],
		[2, 600, 800, 400, 650],
		[3, 800, 600, 450, 200],
	])("maps a shell click at quarter turn %i to unrotated PDF points", (rotation, width, height, x, y) => {
		expect(
			syncTexClickPoint(
				{ x: 500, y: 400 },
				{ left: 100, top: 100, width: width * 2, height: height * 2 },
				{ width: 600, height: 800 },
				rotation,
			),
		).toEqual({ x, y });
	});

	it("ignores clicks outside the page and unlaid-out pages", () => {
		expect(
			syncTexClickPoint(
				{ x: 5, y: 5 },
				{ left: 10, top: 10, width: 600, height: 800 },
				{ width: 600, height: 800 },
				0,
			),
		).toBeNull();
		expect(
			syncTexClickPoint(
				{ x: 10, y: 10 },
				{ left: 0, top: 0, width: 0, height: 0 },
				{ width: 600, height: 800 },
				0,
			),
		).toBeNull();
	});

	it("keeps a baseline-sized locate indicator visible inside page bounds", () => {
		expect(
			syncTexHighlightBox(
				{ page: 2, x: 590, y: 795, width: 100, height: 0 },
				{ width: 600, height: 800 },
			),
		).toEqual({ x: 590 / 600, y: 795 / 800, w: 1 - 590 / 600, h: 4 / 800 });
	});
});
