import { describe, expect, it } from "vitest";
import { planVisualTraceJump } from "@/lib/pdf/visual-trace-jump";

describe("planVisualTraceJump", () => {
	it("scrolls to the union of the crop and does not open the card", () => {
		const plan = planVisualTraceJump(
			{
				page: 3,
				rects: [
					{ x: 0.2, y: 0.4, w: 0.1, h: 0.05 },
					{ x: 0.25, y: 0.42, w: 0.2, h: 0.08 },
				],
			},
			{ width: 500, height: 800 },
		);
		expect(plan.opensCard).toBe(false);
		expect(plan.pageNumber).toBe(3);
		expect(plan.pageIndex).toBe(2);
		expect(plan.bbox?.x).toBeCloseTo(0.2);
		expect(plan.bbox?.y).toBeCloseTo(0.4);
		expect(plan.bbox?.w).toBeCloseTo(0.25);
		expect(plan.bbox?.h).toBeCloseTo(0.1);
		expect(plan.pageCoordinates?.x).toBeCloseTo(100);
		expect(plan.pageCoordinates?.y).toBeCloseTo(320);
	});

	it("still scrolls to the page when the crop is empty", () => {
		const plan = planVisualTraceJump({ page: 1, rects: [] });
		expect(plan.opensCard).toBe(false);
		expect(plan.pageNumber).toBe(1);
		expect(plan.bbox).toBeNull();
		expect(plan.pageCoordinates).toBeUndefined();
	});
});
