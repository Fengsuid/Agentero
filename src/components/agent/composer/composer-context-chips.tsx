import { Quote, ScanSearch, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ContextPathIcon } from "@/components/agent/context-path-icon";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { selectionLineLabel } from "@/lib/agent/selection-line-label";
import type { SelectionContext } from "@/lib/agent/selection-store";
import {
	type PdfVisualDraft,
	updateVisualDraftComment,
} from "@/lib/agent/visual-context-store";
import { basenameOf } from "@/lib/core/path";
import { cn, truncateToChars } from "@/lib/core/utils";

/** Matches `normalizeComment` in the visual draft store. */
const MAX_VISUAL_COMMENT_CHARS = 2000;

const MAX_CHIP_TITLE_CHARS = 9;

/**
 * Icon-first chip: hover / focus animates width open to reveal a short label + X.
 * No `title` tooltip — the expand is the reveal.
 */
function ChipExpandTrail({
	label,
	withRemove,
}: {
	label: string;
	withRemove?: boolean;
}) {
	const trimmed = label.trim();
	if (!trimmed && !withRemove) return null;
	return (
		<span
			className={cn(
				"grid min-w-0 transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none",
				"grid-cols-[0fr] group-hover:grid-cols-[1fr] group-focus-visible:grid-cols-[1fr]",
			)}
		>
			<span className="min-w-0 overflow-hidden">
				<span className="ml-1 flex max-w-[8rem] items-center gap-1 whitespace-nowrap">
					{trimmed ? (
						<span className="min-w-0 truncate text-xs leading-none">
							{trimmed}
						</span>
					) : null}
					{withRemove ? (
						<X className="size-3 shrink-0 text-muted-foreground" aria-hidden />
					) : null}
				</span>
			</span>
		</span>
	);
}

function chipShellClass(extra?: string) {
	return cn(
		"group inline-flex h-7 max-w-full items-center rounded-full border bg-muted/20 px-1.5 text-foreground text-xs transition-colors hover:bg-muted",
		extra,
	);
}

export function ComposerContextChips({
	currentFilePath,
	currentFileLabel,
	mentionChipPaths,
	selectionChips,
	onRemoveSelection,
	visualDrafts,
	onRemoveVisualDraft,
	directoryPathSet,
	paperPathSet,
	labelForPath,
	onRemoveContextPath,
}: {
	/** @deprecated Ignored — chips always expand on hover. */
	compact?: boolean;
	currentFilePath: string | null;
	currentFileLabel: string;
	mentionChipPaths: string[];
	selectionChips: SelectionContext[];
	onRemoveSelection: (id: string) => void;
	visualDrafts: PdfVisualDraft[];
	onRemoveVisualDraft: (id: string) => void;
	directoryPathSet: ReadonlySet<string>;
	paperPathSet: ReadonlySet<string>;
	labelForPath: (path: string) => string;
	onRemoveContextPath: (path: string) => void;
}) {
	const { t } = useTranslation(["agent", "common"]);
	const [openVisualId, setOpenVisualId] = useState<string | null>(null);
	const openVisual =
		visualDrafts.find((draft) => draft.id === openVisualId) ?? null;
	if (
		!currentFilePath &&
		mentionChipPaths.length === 0 &&
		selectionChips.length === 0 &&
		visualDrafts.length === 0
	) {
		return null;
	}

	return (
		<>
			{currentFilePath ? (
				<button
					type="button"
					className={chipShellClass()}
					onClick={() => onRemoveContextPath(currentFilePath)}
					aria-label={t("composer.currentFileRemove")}
				>
					<ContextPathIcon
						path={currentFilePath}
						directoryPaths={directoryPathSet}
						paperPaths={paperPathSet}
					/>
					<ChipExpandTrail
						label={
							currentFileLabel.trim() ||
							basenameOf(currentFilePath) ||
							currentFilePath
						}
						withRemove
					/>
				</button>
			) : null}
			{mentionChipPaths.map((path) => {
				const shortLabel = basenameOf(path) || labelForPath(path);
				return (
					<button
						key={path}
						type="button"
						className={chipShellClass()}
						onClick={() => onRemoveContextPath(path)}
						aria-label={t("composer.removeContext", { path })}
					>
						<ContextPathIcon
							path={path}
							directoryPaths={directoryPathSet}
							paperPaths={paperPathSet}
						/>
						<ChipExpandTrail label={shortLabel} withRemove />
					</button>
				);
			})}
			{selectionChips.map((sel) => {
				const name = truncateToChars(
					basenameOf(sel.sourcePath) || t("composer.selection"),
					MAX_CHIP_TITLE_CHARS,
				);
				const shortLabel =
					(sel.page ? `${name} · p.${sel.page}` : null) ??
					selectionLineLabel(t, sel, name) ??
					name;
				return (
					<button
						key={sel.id}
						title={[sel.text, sel.comment].filter(Boolean).join("\n\n")}
						type="button"
						className={chipShellClass(
							sel.pinned ? undefined : "border-dashed bg-transparent",
						)}
						onClick={() => onRemoveSelection(sel.id)}
						aria-label={t("composer.removeSelection")}
					>
						<Quote className="size-3.5 shrink-0 text-muted-foreground" />
						<ChipExpandTrail label={shortLabel} withRemove />
					</button>
				);
			})}
			{visualDrafts.map((draft, index) => {
				const pageLabel = t("composer.visualAnnotationPage", {
					page: draft.page,
				});
				const shortLabel = draft.comment.trim() || pageLabel;
				const thumb =
					draft.image.data.length > 0
						? `data:${draft.image.mimeType || "image/png"};base64,${draft.image.data}`
						: null;
				return (
					<button
						key={draft.id}
						type="button"
						className={chipShellClass()}
						onClick={() => setOpenVisualId(draft.id)}
						title={t("composer.visualAnnotationOpen")}
						aria-label={t("composer.visualAnnotationOpenAria", {
							index: index + 1,
							label: shortLabel,
						})}
					>
						{thumb ? (
							<img
								src={thumb}
								alt=""
								className="size-5 shrink-0 rounded-full object-cover"
							/>
						) : (
							<ScanSearch className="size-3.5 shrink-0 text-muted-foreground" />
						)}
						<ChipExpandTrail label={shortLabel} />
					</button>
				);
			})}
			<VisualDraftDialog
				draft={openVisual}
				index={
					openVisual
						? visualDrafts.findIndex((draft) => draft.id === openVisual.id) + 1
						: 1
				}
				onClose={() => setOpenVisualId(null)}
				onRemove={onRemoveVisualDraft}
			/>
		</>
	);
}

/**
 * Enlarge a pending visual annotation. The note is edited here and delete is
 * explicit — clicking the chip itself must not drop the draft.
 */
function VisualDraftDialog({
	draft,
	index,
	onClose,
	onRemove,
}: {
	draft: PdfVisualDraft | null;
	index: number;
	onClose: () => void;
	onRemove: (id: string) => void;
}) {
	const { t } = useTranslation(["agent", "common"]);
	return (
		<Dialog
			open={draft != null}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="sm:max-w-md" aria-describedby={undefined}>
				{draft ? (
					<VisualDraftDialogBody
						key={draft.id}
						draft={draft}
						onClose={onClose}
						onRemove={onRemove}
						title={t("composer.visualAnnotationDetailTitle", { index })}
						pageLabel={t("composer.visualAnnotationPage", {
							page: draft.page,
						})}
						commentLabel={t("composer.visualAnnotationCommentLabel")}
						previewAlt={t("composer.visualAnnotationPreviewAlt", {
							page: draft.page,
						})}
						removeLabel={t("common:remove")}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function VisualDraftDialogBody({
	draft,
	onClose,
	onRemove,
	title,
	pageLabel,
	commentLabel,
	previewAlt,
	removeLabel,
}: {
	draft: PdfVisualDraft;
	onClose: () => void;
	onRemove: (id: string) => void;
	title: string;
	pageLabel: string;
	commentLabel: string;
	previewAlt: string;
	removeLabel: string;
}) {
	const [comment, setComment] = useState(draft.comment);
	const thumb =
		draft.image.data.length > 0
			? `data:${draft.image.mimeType || "image/png"};base64,${draft.image.data}`
			: null;
	return (
		<>
			<DialogHeader>
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription>
					{pageLabel}
					{draft.paperPath ? ` · ${draft.paperPath}` : ""}
				</DialogDescription>
			</DialogHeader>
			{thumb ? (
				<img
					src={thumb}
					alt={previewAlt}
					className="max-h-[min(60vh,28rem)] w-full rounded-lg border border-border/70 bg-muted/30 object-contain"
				/>
			) : null}
			<div className="space-y-1">
				<label
					className="font-medium text-muted-foreground text-xs"
					htmlFor={`visual-draft-comment-${draft.id}`}
				>
					{commentLabel}
				</label>
				<Textarea
					id={`visual-draft-comment-${draft.id}`}
					value={comment}
					onChange={(event) => {
						const next = event.target.value.slice(0, MAX_VISUAL_COMMENT_CHARS);
						setComment(next);
						updateVisualDraftComment(draft.id, next);
					}}
				/>
			</div>
			<DialogFooter>
				<Button
					type="button"
					variant="destructive"
					onClick={() => {
						onRemove(draft.id);
						onClose();
					}}
				>
					{removeLabel}
				</Button>
			</DialogFooter>
		</>
	);
}
