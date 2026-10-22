import { shellFractionToUnrotatedPdf } from "@/lib/pdf/page-frame";
import type { SyncTexLocation } from "@/lib/tex/host";

export function syncTexClickPoint(
	client: { x: number; y: number },
	box: { left: number; top: number; width: number; height: number },
	page: { width: number; height: number },
	rotation: number,
) {
	if (box.width <= 0 || box.height <= 0 || page.width <= 0 || page.height <= 0)
		return null;
	const fraction = {
		x: (client.x - box.left) / box.width,
		y: (client.y - box.top) / box.height,
	};
	if (fraction.x < 0 || fraction.x > 1 || fraction.y < 0 || fraction.y > 1)
		return null;
	const point = shellFractionToUnrotatedPdf(
		fraction,
		rotation,
		box.width,
		box.height,
		1,
	);
	return { x: point.x * page.width, y: point.y * page.height };
}

export function syncTexHighlightBox(
	location: SyncTexLocation,
	page: { width: number; height: number },
) {
	const x = Math.max(0, Math.min(1, location.x / page.width));
	const y = Math.max(0, Math.min(1, location.y / page.height));
	return {
		x,
		y,
		w: Math.max(0, Math.min(1 - x, Math.max(4, location.width) / page.width)),
		h: Math.max(0, Math.min(1 - y, Math.max(4, location.height) / page.height)),
	};
}

export function validSyncTexLocation(location: SyncTexLocation): boolean {
	return (
		Number.isInteger(location.page) &&
		location.page > 0 &&
		[location.x, location.y, location.width, location.height].every(
			Number.isFinite,
		)
	);
}
