/** Gap between a fixed hover card and the window edge. */
export const ANCHORED_POPOVER_MARGIN_PX = 8;

/** Resolve a rem length against the document root, falling back to 16px. */
export function remToPx(rem: number): number {
	const root = Number.parseFloat(
		getComputedStyle(document.documentElement).fontSize,
	);
	const px = Number.isFinite(root) && root > 0 ? root : 16;
	return px * rem;
}

export type AnchoredPopoverPosition = {
	left: number;
	top: number;
	width: number;
	transform?: string;
};

/**
 * Place a fixed card on an anchor. The card's right edge stays inside the
 * window: when the anchor sits near that edge, the card shifts left until it
 * is flush with the margin.
 */
export function placeAnchoredPopover(
	anchor: { left: number; top: number; bottom: number },
	options: {
		width: number;
		viewportWidth: number;
		placeBelow: boolean;
		margin?: number;
		gap?: number;
	},
): AnchoredPopoverPosition {
	const margin = options.margin ?? ANCHORED_POPOVER_MARGIN_PX;
	const gap = options.gap ?? 6;
	const viewport = Math.max(0, options.viewportWidth);
	const available = Math.max(0, viewport - margin * 2);
	const width = Math.min(Math.max(0, options.width), available);
	const minLeft = Math.min(margin, Math.max(0, viewport - width));
	const maxLeft = Math.max(minLeft, viewport - margin - width);
	const left = Math.min(Math.max(anchor.left, minLeft), maxLeft);
	if (options.placeBelow) {
		return { left, top: anchor.bottom + gap, width };
	}
	return {
		left,
		top: anchor.top - gap,
		width,
		transform: "translateY(-100%)",
	};
}
