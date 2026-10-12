import {
	type Rotation,
	transformPosition,
	transformRect,
} from "@embedpdf/models";
import { describe, expect, it } from "vitest";
import {
	shellFractionToUnrotatedPdf,
	unrotatedPageFrameTransform,
} from "@/lib/pdf/page-frame";

function applyMatrix(
	transform: string,
	x: number,
	y: number,
): { x: number; y: number } {
	const matched = transform.match(/matrix\(([^)]+)\)/);
	if (!matched?.[1]) throw new Error(`bad transform ${transform}`);
	const [a, b, c, d, e, f] = matched[1].split(",").map((part) => Number(part));
	return { x: a * x + c * y + e, y: b * x + d * y + f };
}

describe("unrotatedPageFrameTransform", () => {
	it("is identity when the page is upright", () => {
		expect(unrotatedPageFrameTransform(0, 800, 1200)).toBeUndefined();
		expect(unrotatedPageFrameTransform(4, 800, 1200)).toBeUndefined();
	});

	it("lands highlight rects on the same box tiles use after zoom", () => {
		const scale = 2.25;
		const container = { width: 595 * scale, height: 842 * scale };
		const rect = {
			origin: { x: 72 * scale, y: 140 * scale },
			size: { width: 180 * scale, height: 14 * scale },
		};
		for (const rotation of [1, 2, 3] as const satisfies readonly Rotation[]) {
			const transform = unrotatedPageFrameTransform(
				rotation,
				container.width,
				container.height,
			);
			expect(transform).toBeTruthy();
			const corners = [
				[rect.origin.x, rect.origin.y],
				[rect.origin.x + rect.size.width, rect.origin.y],
				[rect.origin.x, rect.origin.y + rect.size.height],
				[rect.origin.x + rect.size.width, rect.origin.y + rect.size.height],
			].map(([x, y]) => applyMatrix(transform ?? "", x, y));
			const minX = Math.min(...corners.map((corner) => corner.x));
			const minY = Math.min(...corners.map((corner) => corner.y));
			const maxX = Math.max(...corners.map((corner) => corner.x));
			const maxY = Math.max(...corners.map((corner) => corner.y));
			const placed = transformRect(container, rect, rotation, 1);
			expect(minX).toBeCloseTo(placed.origin.x, 4);
			expect(minY).toBeCloseTo(placed.origin.y, 4);
			expect(maxX - minX).toBeCloseTo(placed.size.width, 4);
			expect(maxY - minY).toBeCloseTo(placed.size.height, 4);
			const sample = { x: 90 * scale, y: 200 * scale };
			const mapped = applyMatrix(transform ?? "", sample.x, sample.y);
			const expected = transformPosition(container, sample, rotation, 1);
			expect(mapped.x).toBeCloseTo(expected.x, 4);
			expect(mapped.y).toBeCloseTo(expected.y, 4);
		}
	});
});

describe("shellFractionToUnrotatedPdf", () => {
	it("keeps upright hit tests as shell fractions at any zoom", () => {
		expect(
			shellFractionToUnrotatedPdf({ x: 0.2, y: 0.35 }, 0, 900, 1200, 1.8),
		).toEqual({ x: 0.2, y: 0.35 });
	});

	it("inverts a zoomed rotated shell point back to the unrotated page fraction", () => {
		const page = { width: 400, height: 800 };
		const scale = 2;
		const container = {
			width: page.width * scale,
			height: page.height * scale,
		};
		const pdf = { x: 100, y: 200 };
		const css = { x: pdf.x * scale, y: pdf.y * scale };
		const rotation = 1 as const;
		const visual = transformPosition(container, css, rotation, 1);
		const shell = { width: container.height, height: container.width };
		const fraction = shellFractionToUnrotatedPdf(
			{ x: visual.x / shell.width, y: visual.y / shell.height },
			rotation,
			shell.width,
			shell.height,
			scale,
		);
		expect(fraction.x).toBeCloseTo(pdf.x / page.width, 5);
		expect(fraction.y).toBeCloseTo(pdf.y / page.height, 5);
	});
});
