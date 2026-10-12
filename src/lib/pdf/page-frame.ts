import { type Rotation, restorePosition } from "@embedpdf/models";

/**
 * Quarter-turns of a PDF page (`/Rotate` plus the viewer's rotation), in
 * EmbedPDF's 0–3 range. Same convention as plugin-tiling's `transformRect`.
 */
export function pageQuarterTurns(rotation: number): Rotation {
	const quarter = Math.round(rotation) % 4;
	return ((quarter + 4) % 4) as Rotation;
}

/**
 * CSS transform that maps an element sized to the unrotated page
 * (`widthPx` × `heightPx`, origin at the shell's top-left) onto the rotated
 * page shell. Identity when the page is upright.
 *
 * Tiles already place unrotated screen rects with `transformRect`. Highlight
 * and selection layers still paint `origin * scale` in unrotated space, so
 * without this they drift off the glyphs, and the gap grows with zoom.
 */
export function unrotatedPageFrameTransform(
	rotation: number,
	unrotatedWidthPx: number,
	unrotatedHeightPx: number,
): string | undefined {
	const quarter = pageQuarterTurns(rotation);
	if (quarter === 0) return undefined;
	const w = unrotatedWidthPx;
	const h = unrotatedHeightPx;
	switch (quarter) {
		case 1:
			return `matrix(0, 1, -1, 0, ${h}, 0)`;
		case 2:
			return `matrix(-1, 0, 0, -1, ${w}, ${h})`;
		case 3:
			return `matrix(0, -1, 1, 0, 0, ${w})`;
		default:
			return undefined;
	}
}

/**
 * Map a point measured as a fraction of the rotated page shell back to a
 * fraction of the unrotated page. Rotation 0 returns the shell fraction, so
 * upright pages keep the zoom-invariant hit test (including CSS zoom preview,
 * where the live box and the layout size differ).
 */
export function shellFractionToUnrotatedPdf(
	fraction: { x: number; y: number },
	rotation: number,
	shellWidthPx: number,
	shellHeightPx: number,
	zoom: number,
): { x: number; y: number } {
	const quarter = pageQuarterTurns(rotation);
	if (
		quarter === 0 ||
		!(shellWidthPx > 0) ||
		!(shellHeightPx > 0) ||
		!Number.isFinite(fraction.x) ||
		!Number.isFinite(fraction.y)
	) {
		return fraction;
	}
	const zoomSafe = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
	const point = restorePosition(
		{ width: shellWidthPx, height: shellHeightPx },
		{ x: fraction.x * shellWidthPx, y: fraction.y * shellHeightPx },
		quarter,
		zoomSafe,
	);
	const unrotatedW =
		(quarter % 2 === 1 ? shellHeightPx : shellWidthPx) / zoomSafe;
	const unrotatedH =
		(quarter % 2 === 1 ? shellWidthPx : shellHeightPx) / zoomSafe;
	if (!(unrotatedW > 0) || !(unrotatedH > 0)) return fraction;
	return { x: point.x / unrotatedW, y: point.y / unrotatedH };
}
