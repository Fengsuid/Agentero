import { ArrowUpRight, BookCheck, Import, Loader2 } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { CitationImportPopover } from "@/components/viewer/citation-import-menu";
import { PreviewArrow } from "@/components/viewer/pdf/cards/preview-arrow";
import { PDF_FLOAT_CARD } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { computePreviewPlacement } from "@/components/viewer/pdf/preview-placement";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import type { Citation } from "@/lib/paper/refs";
import {
	citationExternalUrl,
	citationImportIdentifier,
} from "@/lib/paper/refs";

const CARD_WIDTH = 300;
const CARD_ESTIMATED_HEIGHT = 110;
/** Cap stacked range previews so a wide `1-30` cluster stays usable. */
const LIST_MAX_HEIGHT = 280;

export type CitationPreviewImportMenu = {
	folders: string[];
	lastImportParentDir: string;
	importingId: string | null;
	onImport: (citation: Citation, folder: string) => void;
	/** Lets the hover card stay open while the folder picker is up. */
	onOpenChange: (open: boolean) => void;
	/**
	 * True for remote papers: every citation row shows an import button that
	 * imports the current paper, because individual reference metadata is not
	 * available until the paper is in the library.
	 */
	remotePaper?: boolean;
};

function citationMetaParts(citation: Citation): string[] {
	const m = citation.metadata;
	return [
		m.authors?.length
			? m.authors.length > 1
				? `${m.authors[0]} et al.`
				: m.authors[0]
			: null,
		m.year != null ? String(m.year) : null,
		m.venue || null,
	].filter(Boolean) as string[];
}

function CitationPreviewRow({
	citation,
	importMenu,
	showDivider,
}: {
	citation: Citation;
	importMenu?: CitationPreviewImportMenu;
	showDivider: boolean;
}) {
	const { t } = useTranslation("viewer");
	const m = citation.metadata;
	const metaParts = citationMetaParts(citation);
	const inLibrary = Boolean(citation.localMatch);
	const importable =
		!inLibrary &&
		(citationImportIdentifier(citation) != null || importMenu?.remotePaper);
	const link = citationExternalUrl(citation);
	const importing = importMenu?.importingId === citation.id;
	// Numbered refs show `[7]`. Unnumbered bib keys become `cite-…` ids with no
	// spaces; `shrink-0` lets that string paint past the 300px card.
	const label =
		citation.display || citation.id.replace(/^ref-?/i, "") || citation.id;

	const importIcon = importing ? (
		<Loader2 className="size-3.5 animate-spin" aria-hidden />
	) : (
		<Import className="size-3.5" aria-hidden />
	);

	return (
		<div
			className={showDivider ? "border-border/60 border-t pt-2.5" : undefined}
		>
			<div className="flex items-start justify-between gap-2">
				<span className="min-w-0 break-all font-medium text-caption text-muted-foreground tabular-nums">
					{label}
				</span>
				<span className="flex shrink-0 items-center gap-1">
					{inLibrary ? (
						<BookCheck
							className="size-3.5 text-emerald-600 dark:text-emerald-500"
							aria-label={t("references.inLibrary")}
						/>
					) : importable && importMenu ? (
						<CitationImportPopover
							citationId={citation.id}
							folders={importMenu.folders}
							lastImportParentDir={importMenu.lastImportParentDir}
							importing={importing}
							onImport={(folder) => importMenu.onImport(citation, folder)}
							onOpenChange={importMenu.onOpenChange}
						>
							<button
								type="button"
								className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
								aria-label={t("references.import")}
								disabled={importing}
								onClick={(e) => e.stopPropagation()}
							>
								{importIcon}
							</button>
						</CitationImportPopover>
					) : (
						<Import
							className="size-3.5 text-muted-foreground"
							aria-label={t("references.import")}
						/>
					)}
					{link ? (
						<button
							type="button"
							className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
							aria-label={t("references.openLink")}
							onClick={(e) => {
								e.stopPropagation();
								openExternalUrl(link);
							}}
						>
							<ArrowUpRight className="size-3.5" aria-hidden />
						</button>
					) : null}
				</span>
			</div>
			<p className="mt-1 line-clamp-2 text-sm leading-snug text-foreground">
				{m.title ?? citation.raw ?? citation.rawKey ?? citation.id}
			</p>
			{metaParts.length ? (
				<p className="mt-0.5 truncate text-caption text-muted-foreground">
					{metaParts.join(" · ")}
				</p>
			) : null}
		</div>
	);
}

/**
 * Hover card for an in-text citation link: the reference(s) it points at.
 * A single hyperref hit is one row; ACS ranges like `14-18` list every index
 * in the expanded cluster. Only mounted when at least one match exists.
 */
export function PdfCitationPreview({
	screen,
	matched,
	importMenu,
	onPointerEnter,
	onPointerLeave,
}: {
	screen: ScreenPoint;
	matched: Citation[];
	importMenu?: CitationPreviewImportMenu;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
}) {
	const { t } = useTranslation("viewer");
	const rootRef = useRef<HTMLDivElement>(null);
	const viewportWidth =
		typeof window === "undefined" ? 1200 : window.innerWidth;
	const viewportHeight =
		typeof window === "undefined" ? 800 : window.innerHeight;
	const cardEstimatedHeight =
		matched.length <= 1
			? CARD_ESTIMATED_HEIGHT
			: Math.min(LIST_MAX_HEIGHT, 28 + matched.length * 72);

	const { placement, left, top, bottom, arrowLeft, maxContentHeight } =
		computePreviewPlacement({
			screen,
			cardWidth: CARD_WIDTH,
			cardEstimatedHeight,
			viewportWidth,
			viewportHeight,
		});

	const maxListHeight = Math.min(LIST_MAX_HEIGHT, maxContentHeight);

	// Mount under an existing pointer skips pointerenter — re-arm sticky hover.
	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		if (el.matches(":hover")) onPointerEnter();
	}, [onPointerEnter]);

	const handlePointerLeave = (e: ReactPointerEvent<HTMLDivElement>) => {
		const next = e.relatedTarget;
		if (next instanceof Node && e.currentTarget.contains(next)) return;
		onPointerLeave();
	};

	return (
		<div
			ref={rootRef}
			role="dialog"
			aria-label={t("references.previewLabel")}
			data-pdf-chrome
			className={cn(
				"fixed z-50 w-[300px] p-3",
				PDF_FLOAT_CARD,
				placement === "bottom" ? "origin-top" : "origin-bottom",
				"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150 motion-reduce:animate-none",
			)}
			style={{ left, top, bottom }}
			onPointerEnter={onPointerEnter}
			onPointerLeave={handlePointerLeave}
		>
			<PreviewArrow placement={placement} left={arrowLeft} />
			<div
				className={
					matched.length > 1
						? "flex flex-col gap-2.5 overflow-y-auto"
						: undefined
				}
				style={
					matched.length > 1 ? { maxHeight: `${maxListHeight}px` } : undefined
				}
			>
				{matched.map((citation, index) => (
					<CitationPreviewRow
						key={citation.id}
						citation={citation}
						importMenu={importMenu}
						showDivider={index > 0}
					/>
				))}
			</div>
		</div>
	);
}
