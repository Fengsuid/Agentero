import { Trash2, X } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ContextPathIcon } from "@/components/agent/context-path-icon";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	type PdfVisualDraft,
	updateVisualDraftComment,
} from "@/lib/agent/visual-context-store";
import { basenameOf } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";

/** Matches `normalizeComment` in the visual draft store. */
const MAX_VISUAL_COMMENT_CHARS = 2000;

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
	directoryPathSet: ReadonlySet<string>;
	paperPathSet: ReadonlySet<string>;
	labelForPath: (path: string) => string;
	onRemoveContextPath: (path: string) => void;
}) {
	const { t } = useTranslation(["agent", "common"]);
	if (!currentFilePath && mentionChipPaths.length === 0) {
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
		</>
	);
}

/**
 * Hover card for one visual reference. The note is edited here and delete is
 * explicit — hovering or clicking the reference itself must not drop the draft.
 */
export function VisualReferenceCard({
	draft,
	index,
	anchor,
	onHoverHold,
	onHoverRelease,
	onRemove,
}: {
	draft: PdfVisualDraft;
	index: number;
	anchor: HTMLElement;
	onHoverHold: () => void;
	onHoverRelease: () => void;
	onRemove: (id: string) => void;
}) {
	const { t } = useTranslation(["agent", "common"]);
	const [rect, setRect] = useState(() => anchor.getBoundingClientRect());
	useLayoutEffect(() => {
		const update = () => {
			if (!anchor.isConnected) {
				onHoverRelease();
				return;
			}
			setRect(anchor.getBoundingClientRect());
		};
		update();
		window.addEventListener("scroll", update, true);
		window.addEventListener("resize", update);
		return () => {
			window.removeEventListener("scroll", update, true);
			window.removeEventListener("resize", update);
		};
	}, [anchor, onHoverRelease]);
	useLayoutEffect(() => {
		if (!anchor.isConnected) onHoverRelease();
	});
	const placeBelow = rect.top < 320;
	if (typeof document === "undefined") return null;
	const pageLabel = t("composer.visualAnnotationPage", { page: draft.page });
	const where = draft.paperPath
		? `${pageLabel} · ${draft.paperPath}`
		: pageLabel;
	return createPortal(
		// Hover bridge into the card. The note field and delete button own the actions.
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer bridge so the card stays open between the reference and its actions
		<div
			data-annotation-ui
			className="fixed z-50 max-h-[min(24rem,calc(100vh-2rem))] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
			style={
				placeBelow
					? { left: rect.left, top: rect.bottom + 6 }
					: {
							left: rect.left,
							top: rect.top - 6,
							transform: "translateY(-100%)",
						}
			}
			onMouseEnter={onHoverHold}
			onMouseLeave={onHoverRelease}
			onMouseDown={(event) => {
				const target = event.target as HTMLElement | null;
				if (target?.closest("textarea, button, input, a")) return;
				event.preventDefault();
			}}
		>
			<VisualReferenceCardBody
				key={draft.id}
				draft={draft}
				index={index}
				where={where}
				commentLabel={t("composer.visualAnnotationCommentLabel")}
				previewAlt={t("composer.visualAnnotationPreviewAlt", {
					page: draft.page,
				})}
				removeLabel={t("common:remove")}
				onRemove={() => {
					onRemove(draft.id);
					onHoverRelease();
				}}
			/>
		</div>,
		document.body,
	);
}

function VisualReferenceCardBody({
	draft,
	index,
	where,
	commentLabel,
	previewAlt,
	removeLabel,
	onRemove,
}: {
	draft: PdfVisualDraft;
	index: number;
	where: string;
	commentLabel: string;
	previewAlt: string;
	removeLabel: string;
	onRemove: () => void;
}) {
	const [comment, setComment] = useState(draft.comment);
	const thumb =
		draft.image.data.length > 0
			? `data:${draft.image.mimeType || "image/png"};base64,${draft.image.data}`
			: null;
	return (
		<div className="flex gap-2 p-3">
			<span className="text-muted-foreground">{index}.</span>
			<div className="min-w-0 flex-1">
				<p className="truncate text-xs text-muted-foreground">{where}</p>
				{thumb ? (
					<img
						src={thumb}
						alt={previewAlt}
						className="mt-2 max-h-40 w-full rounded-md border border-border/70 bg-muted/30 object-contain"
					/>
				) : null}
				<label
					className="mt-3 mb-1 block text-xs text-muted-foreground"
					htmlFor={`visual-draft-comment-${draft.id}`}
				>
					{commentLabel}
				</label>
				<Textarea
					id={`visual-draft-comment-${draft.id}`}
					value={comment}
					rows={3}
					onChange={(event) => {
						const next = event.target.value.slice(0, MAX_VISUAL_COMMENT_CHARS);
						setComment(next);
						updateVisualDraftComment(draft.id, next);
					}}
				/>
			</div>
			<Button
				type="button"
				size="icon-sm"
				variant="ghost"
				className="shrink-0"
				aria-label={removeLabel}
				onClick={onRemove}
			>
				<Trash2 className="size-4" />
			</Button>
		</div>
	);
}
