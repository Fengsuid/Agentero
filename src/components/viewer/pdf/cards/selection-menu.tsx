import { Check, Copy, Languages } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	HIGHLIGHT_COLOR_STACK_WIDTH_DELTA,
	HighlightColorStack,
} from "@/components/viewer/pdf/cards/highlight-color-stack";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { cn } from "@/lib/core/utils";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import type { MenuContext } from "@/lib/shell/commands/menu-contributions";
import {
	activateMenuContribution,
	visibleMenuContributions,
} from "@/lib/shell/commands/menu-contributions";
import { formatModShortcut } from "@/lib/shell/shortcuts";
import { useSelectionOverlayGuard } from "@/lib/workspace/selection-overlay";

type SelectionMenuProps = {
	/** Screen point near the top-center of the selection (toolbar anchor) */
	screen: ScreenPoint;
	/** Create a highlight in the chosen color */
	onHighlight: (color: HighlightColor) => void;
	/** Open an in-page Ask (quick chat) thread for the selection. */
	onAsk: () => void;
	/** Open an optional inline comment before adding the quote to chat. */
	onAddToChat: () => void;
	onTranslate: () => void;
	onCopy?: () => Promise<boolean>;
	/** Show the highlight color stack (needs marks/ to persist into). */
	showHighlight?: boolean;
	/** Show the translate action (ephemeral cards on surfaces without marks/). */
	showTranslate?: boolean;
	/**
	 * PDF selection only. HTML and the text editor omit this, so their
	 * toolbars do not query `pdf.selection`.
	 */
	contributionContext?: MenuContext;
};

const BAR_H = 32;
const COPIED_FLASH_MS = 1500;

function SelectionCopyButton({
	onCopy,
	label,
	copiedLabel,
	shortcut,
}: {
	onCopy: () => Promise<boolean>;
	label: string;
	copiedLabel: string;
	shortcut: string;
}) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const handleClick = useCallback(() => {
		void (async () => {
			const ok = await onCopy();
			if (!mountedRef.current || ok === false) return;
			setCopied(true);
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				if (mountedRef.current) setCopied(false);
			}, COPIED_FLASH_MS);
		})();
	}, [onCopy]);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="size-7"
					aria-label={copied ? copiedLabel : `${label} ${shortcut}`}
					onPointerDown={(event) => event.preventDefault()}
					onClick={handleClick}
				>
					{copied ? (
						<Check className="size-3.5" />
					) : (
						<Copy className="size-3.5" />
					)}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Floating action bar shown next to a text selection: overlapping highlight
 * color dots (fan left on hover), then Translate / Copy / Quick chat / Add to chat.
 * Copy keeps the bar open and swaps the icon for a check; it does not toast.
 * The bar is pinned by its right edge so expanding colors only grow left —
 * action buttons never shift.
 * Annotate lives on the right-rail selection comment chip instead.
 * `showHighlight` / `showTranslate` hide the persistent actions on surfaces
 * without marks/ (remote papers, proxied web pages).
 * Visible `pdf.selection` contributions append after the built-in buttons.
 */
export function SelectionMenu({
	screen,
	onHighlight,
	onAsk,
	onAddToChat,
	onTranslate,
	onCopy,
	showHighlight = true,
	showTranslate = true,
	contributionContext,
}: SelectionMenuProps) {
	const { t } = useTranslation("viewer");
	// Suspend dockview drag-and-drop while this toolbar floats over the tab
	// strip so a stray drag cannot split the layout (#608).
	useSelectionOverlayGuard();
	// ⌘K = in-page Quick chat (Ask); ⌘L = Add to chat (pin + open Agent).
	const quickChatShortcut = formatModShortcut("k");
	const addToChatShortcut = formatModShortcut("l");
	const copyShortcut = formatModShortcut("c");
	const contributions = contributionContext
		? visibleMenuContributions("pdf.selection", contributionContext)
		: [];

	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	// Approximate collapsed width for centering; flex content sizes the real bar.
	// Pin with CSS `right` so stack width changes grow left without moving actions.
	// Zero contributions keep the built-in width.
	const barW =
		(showTranslate ? 280 : 200) +
		(onCopy ? 32 : 0) +
		(contributions.length > 0 ? contributions.length * 72 : 0);
	const expandPad = showHighlight ? HIGHLIGHT_COLOR_STACK_WIDTH_DELTA : 0;
	let left = screen.x - barW / 2;
	// Leave room on the left so the color stack can expand without clipping.
	left = Math.min(Math.max(12 + expandPad, left), vw - barW - 12);
	const right = vw - (left + barW);
	// Prefer just above the selection; flip below if near the top edge.
	let top = screen.y - BAR_H - 10;
	let overContent = false;
	if (top < 12) {
		top = Math.min(vh - BAR_H - 12, screen.y + 18);
		// Menu sits below the selection and may cover body text.
		overContent = true;
	}
	// Keep the toolbar on-screen when the selection scrolls out of view; dim it
	// so it does not look glued to an off-screen anchor.
	const clampedTop = Math.max(12, Math.min(vh - BAR_H - 12, top));
	const scrolledAway = clampedTop !== top;
	top = clampedTop;
	const dimmed = overContent || scrolledAway;

	return (
		<div
			data-pdf-chrome
			className={cn(
				"fixed z-50 flex h-8 items-center gap-0.5 rounded-md border border-border/80 bg-background px-1 shadow-2xl ring-1 ring-black/5 transition-[background-color,opacity] duration-150 dark:ring-white/10",
				// Dim when covering body text or when the selection scrolled away.
				dimmed &&
					"bg-background/80 opacity-70 backdrop-blur-sm hover:bg-background hover:opacity-100",
			)}
			style={{ top, right }}
			role="toolbar"
			aria-label={t("selection.menuLabel")}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<TooltipProvider delayDuration={200}>
				{showHighlight ? (
					<>
						<HighlightColorStack onSelect={onHighlight} />
						<div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
					</>
				) : null}
				{showTranslate ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="size-7"
								aria-label={t("selection.translate")}
								onClick={onTranslate}
							>
								<Languages className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="top">
							{t("selection.translate")}
						</TooltipContent>
					</Tooltip>
				) : null}
				{onCopy ? (
					<SelectionCopyButton
						onCopy={onCopy}
						label={t("selection.copy")}
						copiedLabel={t("selection.copied")}
						shortcut={copyShortcut}
					/>
				) : null}
				<button
					type="button"
					className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:active:scale-100"
					aria-label={`${t("selection.quickChat")} ${quickChatShortcut}`}
					onClick={onAsk}
				>
					<span>{t("selection.quickChat")}</span>
					<kbd className="translate-y-px scale-90 text-caption font-normal text-muted-foreground/80 tabular-nums">
						{quickChatShortcut}
					</kbd>
				</button>
				<button
					type="button"
					className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:active:scale-100"
					aria-label={`${t("selection.addToChat")} ${addToChatShortcut}`}
					onPointerDown={(event) => event.preventDefault()}
					onClick={onAddToChat}
				>
					<span>{t("selection.addToChat")}</span>
					<kbd className="translate-y-px scale-90 text-caption font-normal text-muted-foreground/80 tabular-nums">
						{addToChatShortcut}
					</kbd>
				</button>
				{contributions.length > 0 ? (
					<>
						<div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
						{contributions.map((item) => (
							<button
								key={item.id}
								type="button"
								className="inline-flex h-7 shrink-0 items-center rounded-md px-1.5 text-caption font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:active:scale-100"
								onPointerDown={(event) => event.preventDefault()}
								onClick={() => {
									activateMenuContribution(item);
								}}
							>
								<span>{item.title}</span>
							</button>
						))}
					</>
				) : null}
			</TooltipProvider>
		</div>
	);
}
