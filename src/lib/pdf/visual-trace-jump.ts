import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { unionNormalizedRegions } from "@/lib/pdf/region";

export type VisualTraceJumpPlan = {
	pageNumber: number;
	pageIndex: number;
	bbox: PdfAskNormalizedRect | null;
	pageCoordinates?: { x: number; y: number };
	/**
	 * Annotation links only scroll to the region. The pin click still opens
	 * the floating transcript card.
	 */
	opensCard: false;
};

/**
 * Where a visual-annotation link should land. `pageCoordinates` are unrotated
 * PDF points, the same space `scrollToPage` uses for layout jumps.
 */
export function planVisualTraceJump(
	trace: { page: number; rects: PdfAskNormalizedRect[] },
	pageSize?: { width: number; height: number },
): VisualTraceJumpPlan {
	const pageNumber = Math.max(1, Math.floor(trace.page) || 1);
	const pageIndex = pageNumber - 1;
	const bbox = unionNormalizedRegions(trace.rects);
	const pageCoordinates =
		pageSize && pageSize.width > 0 && pageSize.height > 0 && bbox
			? {
					x: bbox.x * pageSize.width,
					y: bbox.y * pageSize.height,
				}
			: undefined;
	return {
		pageNumber,
		pageIndex,
		bbox,
		...(pageCoordinates ? { pageCoordinates } : {}),
		opensCard: false,
	};
}
