import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { PreviewArrow } from "@/components/viewer/pdf/cards/preview-arrow";
import { PDF_FLOAT_CARD } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import {
	computePreviewPlacement,
	PREVIEW_VIEWPORT_PADDING,
} from "@/components/viewer/pdf/preview-placement";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { cn } from "@/lib/core/utils";

const CARD_WIDTH = 360;
const CARD_ESTIMATED_HEIGHT = 72;

/**
 * Full external-link address. Wraps and scrolls instead of using a native
 * `title`, which the OS truncates. `role="dialog"` + `fixed` keeps the shared
 * sticky-hover check from dismissing the tip while the pointer is on it.
 */
export function PdfLinkUrlTip({
	url,
	screen,
	onPointerEnter,
	onPointerLeave,
}: {
	url: string;
	screen: ScreenPoint;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
}) {
	const { t } = useTranslation("viewer");
	const rootRef = useRef<HTMLDivElement>(null);
	const viewportWidth =
		typeof window === "undefined" ? 1200 : window.innerWidth;
	const viewportHeight =
		typeof window === "undefined" ? 800 : window.innerHeight;
	const cardWidth = Math.min(
		CARD_WIDTH,
		viewportWidth - PREVIEW_VIEWPORT_PADDING * 2,
	);
	const { placement, left, top, bottom, arrowLeft } = computePreviewPlacement({
		screen,
		cardWidth,
		cardEstimatedHeight: CARD_ESTIMATED_HEIGHT,
		cardChromeHeight: 20,
		viewportWidth,
		viewportHeight,
	});

	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		if (el.matches(":hover")) onPointerEnter();
	}, [onPointerEnter]);

	const handlePointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
		const next = event.relatedTarget;
		if (next instanceof Node && event.currentTarget.contains(next)) return;
		onPointerLeave();
	};

	return (
		<div
			ref={rootRef}
			role="dialog"
			aria-label={t("pdf.linkUrl")}
			className={cn(
				"fixed z-50 p-2.5 text-xs leading-relaxed",
				PDF_FLOAT_CARD,
				placement === "bottom" ? "origin-top" : "origin-bottom",
				"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150 motion-reduce:animate-none",
			)}
			style={{ left, top, bottom, width: cardWidth }}
			onPointerEnter={onPointerEnter}
			onPointerLeave={handlePointerLeave}
		>
			<PreviewArrow placement={placement} left={arrowLeft} />
			<p className="agentero-scroll max-h-60 overflow-y-auto break-all whitespace-pre-wrap select-text">
				{url}
			</p>
		</div>
	);
}
