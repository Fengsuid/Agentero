import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { SelectionSourceButton } from "@/components/selection/selection-source-button";
import { Button } from "@/components/ui/button";
import {
	extractSelectionTokens,
	updateSelectionToken,
	withoutSelectionTokens,
} from "@/lib/agent/composer-inline-tokens";
import {
	annotationStore,
	releaseAnnotationAnchor,
} from "@/lib/agent/selection-annotations";
import {
	openAnnotationEditor,
	selectionChatStore,
	suspendSelectionChat,
} from "@/lib/agent/selection-chat-store";

export type SelectionHoverAnchor = {
	id: string;
	anchor: HTMLElement;
};

export function ComposerAnnotations({
	value,
	onChange,
	hover,
	onHoverHold,
	onHoverRelease,
}: {
	value: string;
	onChange: (value: string) => void;
	hover: SelectionHoverAnchor | null;
	onHoverHold: () => void;
	onHoverRelease: () => void;
}) {
	const selections = useMemo(() => extractSelectionTokens(value), [value]);
	const seenIdsRef = useRef<string[]>([]);
	useEffect(() => {
		const ids = selections.map((selection) => selection.id);
		for (const id of seenIdsRef.current) {
			if (!ids.includes(id)) releaseAnnotationAnchor(id);
		}
		seenIdsRef.current = ids;
		const binding = {
			selections,
			update: (id: string, comment: string | null) =>
				onChange(updateSelectionToken(value, id, comment)),
		};
		annotationStore.setState({ binding });
		const draft = selectionChatStore.getState().draft;
		if (draft?.editing && !selections.some((s) => s.id === draft.selection.id))
			suspendSelectionChat();
		return () => {
			if (annotationStore.getState().binding === binding)
				annotationStore.setState({ binding: null });
		};
	}, [selections, value, onChange]);
	const remove = (id?: string) => {
		for (const selection of selections)
			if (!id || selection.id === id) releaseAnnotationAnchor(selection.id);
		onChange(
			id
				? updateSelectionToken(value, id, null)
				: withoutSelectionTokens(value),
		);
	};
	const hovered = hover
		? selections
				.map((selection, index) => ({ selection, index }))
				.find((item) => item.selection.id === hover.id)
		: undefined;
	if (!hover || !hovered) return null;
	return (
		<SelectionReferenceCard
			anchor={hover.anchor}
			index={hovered.index}
			selection={hovered.selection}
			onHoverHold={onHoverHold}
			onHoverRelease={onHoverRelease}
			onEdit={(rect) => {
				onHoverRelease();
				openAnnotationEditor(hovered.selection, {
					x: rect.left,
					y: rect.top,
				});
			}}
			onRemove={() => remove(hovered.selection.id)}
		/>
	);
}

function SelectionReferenceCard({
	anchor,
	index,
	selection,
	onHoverHold,
	onHoverRelease,
	onEdit,
	onRemove,
}: {
	anchor: HTMLElement;
	index: number;
	selection: ReturnType<typeof extractSelectionTokens>[number];
	onHoverHold: () => void;
	onHoverRelease: () => void;
	onEdit: (rect: DOMRect) => void;
	onRemove: () => void;
}) {
	const { t } = useTranslation(["viewer", "common"]);
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
	const placeBelow = rect.top < 220;
	if (typeof document === "undefined") return null;
	return createPortal(
		// Hover bridge into the card. The buttons inside own the actions.
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer bridge so the card stays open between the reference and its actions
		<div
			data-annotation-ui
			className="fixed z-50 max-h-80 w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
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
		>
			<div className="flex gap-2 p-3">
				<span className="text-muted-foreground">{index + 1}.</span>
				<div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">
					<SelectionSourceButton selection={selection} />
					<p className="mb-1 text-xs text-muted-foreground">
						{t("selection.selectedText")}
					</p>
					<p>{selection.text}</p>
					<p className="mb-1 mt-3 text-xs text-muted-foreground">
						{t("selection.userComment")}
					</p>
					<p>{selection.comment || t("selection.noComment")}</p>
				</div>
				<div className="flex shrink-0 items-start">
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label={t("common:edit")}
						onClick={(event) => {
							onEdit(event.currentTarget.getBoundingClientRect());
						}}
					>
						<Pencil className="size-4" />
					</Button>
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label={t("common:remove")}
						onClick={onRemove}
					>
						<Trash2 className="size-4" />
					</Button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
