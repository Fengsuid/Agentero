import type { ScrollMetrics } from "@embedpdf/plugin-scroll";
import {
	pageQuarterTurns,
	shellFractionToUnrotatedPdf,
} from "@/lib/pdf/page-frame";

/** A point on the currently read page, independent of the PDF buffer revision. */
export type PdfReloadPosition = {
	documentId: string;
	page: number;
	zoom: number;
	x: number;
	y: number;
	alignX: number;
	alignY: number;
};

export function capturePdfReloadPosition(
	documentId: string,
	metrics: ScrollMetrics,
	zoom: number,
	viewport: { clientWidth: number; clientHeight: number } | null,
	page?: { size: { width: number; height: number }; rotation: number },
): PdfReloadPosition | null {
	if (!Number.isFinite(zoom) || zoom <= 0 || metrics.currentPage < 1)
		return null;
	const visible = metrics.pageVisibilityMetrics.find(
		(page) => page.pageNumber === metrics.currentPage,
	);
	if (!visible) return null;
	let x = visible.original.pageX;
	let y = visible.original.pageY;
	if (page && page.size.width > 0 && page.size.height > 0) {
		const rotated = pageQuarterTurns(page.rotation) % 2 === 1;
		const width = rotated ? page.size.height : page.size.width;
		const height = rotated ? page.size.width : page.size.height;
		const point = shellFractionToUnrotatedPdf(
			{ x: x / width, y: y / height },
			page.rotation,
			width,
			height,
			1,
		);
		x = point.x * page.size.width;
		y = point.y * page.size.height;
	}
	return {
		documentId,
		page: metrics.currentPage,
		zoom,
		x,
		y,
		alignX: viewport?.clientWidth
			? (visible.viewportX / viewport.clientWidth) * 100
			: 0,
		alignY: viewport?.clientHeight
			? (visible.viewportY / viewport.clientHeight) * 100
			: 0,
	};
}

export function pdfReloadScrollTarget(
	position: PdfReloadPosition,
	totalPages: number,
) {
	return {
		pageNumber: Math.max(1, Math.min(totalPages, position.page)),
		pageCoordinates: { x: position.x, y: position.y },
		alignX: position.alignX,
		alignY: position.alignY,
		behavior: "instant" as const,
	};
}
