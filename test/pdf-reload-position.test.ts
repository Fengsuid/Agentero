import type { ScrollMetrics } from "@embedpdf/plugin-scroll";
import { describe, expect, it } from "vitest";
import {
	capturePdfReloadPosition,
	pdfReloadScrollTarget,
} from "@/lib/pdf/reload-position";

const metrics: ScrollMetrics = {
	currentPage: 7,
	visiblePages: [7],
	pageVisibilityMetrics: [
		{
			pageNumber: 7,
			viewportX: 60,
			viewportY: 0,
			visiblePercentage: 50,
			original: {
				pageX: 0,
				pageY: 325,
				visibleWidth: 500,
				visibleHeight: 300,
				scale: 1,
			},
			scaled: {
				pageX: 0,
				pageY: 650,
				visibleWidth: 1000,
				visibleHeight: 600,
				scale: 2,
			},
		},
	],
	renderedPageIndexes: [6],
	scrollOffset: { x: 0, y: 9000 },
	startSpacing: 0,
	endSpacing: 0,
};

describe("compiled PDF reading position", () => {
	it("restores a point on the read page after preceding pages change height", () => {
		const saved = capturePdfReloadPosition("main::r1", metrics, 2, {
			clientWidth: 1200,
			clientHeight: 800,
		});
		expect(saved).toMatchObject({
			page: 7,
			zoom: 2,
			x: 0,
			y: 325,
			alignX: 5,
			alignY: 0,
		});
		if (!saved) throw new Error("Expected a captured position");
		expect(pdfReloadScrollTarget(saved, 10)).toEqual({
			pageNumber: 7,
			pageCoordinates: { x: 0, y: 325 },
			alignX: 5,
			alignY: 0,
			behavior: "instant",
		});
	});

	it("clamps the restored page when the new PDF has fewer pages", () => {
		const saved = capturePdfReloadPosition("main::r1", metrics, 2, null);
		if (!saved) throw new Error("Expected a captured position");
		expect(pdfReloadScrollTarget(saved, 3).pageNumber).toBe(3);
	});

	it("converts a rotated page's reading point back to unrotated PDF coordinates", () => {
		const saved = capturePdfReloadPosition("rotated::r1", metrics, 2, null, {
			size: { width: 600, height: 800 },
			rotation: 1,
		});
		expect(saved).toMatchObject({ x: 325, y: 800 });
	});

	it("does not replace a valid position with provisional layout metrics", () => {
		expect(
			capturePdfReloadPosition(
				"main::r2",
				{ ...metrics, pageVisibilityMetrics: [] },
				1,
				null,
			),
		).toBeNull();
		expect(
			capturePdfReloadPosition("main::r2", metrics, Number.NaN, null),
		).toBeNull();
	});
});
