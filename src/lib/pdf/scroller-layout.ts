/**
 * Identity of an EmbedPDF scroller layout, ignoring scroll offset.
 *
 * `commitMetrics` pushes a fresh layout object on every scroll frame. The
 * mounted pages only change when the virtual window, scale, or elevation
 * changes. Comparing those fields lets the scroll plugin skip `setState`
 * while the user is still inside the same page window.
 *
 * The plugin-scroll patch calls `globalThis.__agenteroPdfScroll.sameScrollerLayout`.
 */

export type ScrollerLayoutPage = {
	pageIndex?: number;
	rotatedWidth: number;
	rotatedHeight: number;
	width: number;
	height: number;
	elevated?: boolean;
};

export type ScrollerLayoutSnapshot = {
	startSpacing: number;
	endSpacing: number;
	totalWidth: number;
	totalHeight: number;
	pageGap: number;
	strategy: unknown;
	items: ReadonlyArray<{
		pageLayouts: ReadonlyArray<ScrollerLayoutPage>;
	}>;
};

function samePage(a: ScrollerLayoutPage, b: ScrollerLayoutPage): boolean {
	return (
		a.pageIndex === b.pageIndex &&
		a.rotatedWidth === b.rotatedWidth &&
		a.rotatedHeight === b.rotatedHeight &&
		a.width === b.width &&
		a.height === b.height &&
		Boolean(a.elevated) === Boolean(b.elevated)
	);
}

export function sameScrollerLayout(
	a: ScrollerLayoutSnapshot | null | undefined,
	b: ScrollerLayoutSnapshot | null | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (
		a.startSpacing !== b.startSpacing ||
		a.endSpacing !== b.endSpacing ||
		a.totalWidth !== b.totalWidth ||
		a.totalHeight !== b.totalHeight ||
		a.pageGap !== b.pageGap ||
		a.strategy !== b.strategy ||
		a.items.length !== b.items.length
	) {
		return false;
	}
	for (let i = 0; i < a.items.length; i++) {
		const left = a.items[i]?.pageLayouts;
		const right = b.items[i]?.pageLayouts;
		if (!left || !right || left.length !== right.length) return false;
		for (let j = 0; j < left.length; j++) {
			const pageA = left[j];
			const pageB = right[j];
			if (!pageA || !pageB || !samePage(pageA, pageB)) return false;
		}
	}
	return true;
}
