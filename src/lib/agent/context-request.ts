/**
 * Anchors Quick Chat and the sidebar send to the host context resolver.
 * The host writes the minimum evidence and decides whether this session may
 * expand it. These surfaces no longer paste paper paths or quotes into the prompt.
 */
import { planAnnotationRefs } from "@/lib/agent/annotation-prompt";
import { isPlazaMentionPath } from "@/lib/agent/plaza-mention";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { pairedAskTranslation } from "@/lib/pdf/ask/prompt";
import type { PdfAskThread } from "@/lib/pdf/ask/types";

export type ContextSurface = "quick_chat" | "sidebar";

export type ContextAnchorKind = "selection" | "paper" | "mention";

export type ContextAnchor = {
	kind: ContextAnchorKind;
	paperPath?: string;
	filePath?: string;
	page?: number;
	section?: string;
	quote?: string;
	comment?: string;
	lineFrom?: number;
	lineTo?: number;
	before?: string;
	after?: string;
	translation?: string;
	annotation?: number;
};

export type ContextRequest = {
	surface: ContextSurface;
	question: string;
	anchors: ContextAnchor[];
	mode?: "read_only";
};

function selectionAnchor(
	selection: SelectionContext,
	annotation?: number,
): ContextAnchor {
	return {
		kind: "selection",
		filePath: selection.sourcePath,
		page: selection.page,
		section: selection.context?.heading,
		quote: selection.text,
		comment: selection.comment,
		lineFrom: selection.lineFrom,
		lineTo: selection.lineTo,
		before: selection.context?.before,
		after: selection.context?.after,
		translation: selection.context?.translation,
		annotation,
	};
}

/** PDF Quick Chat: the open paper, page, and quote. The host adds the title. */
export function pdfAskContextRequest(thread: PdfAskThread): ContextRequest {
	const translation = pairedAskTranslation(thread.id);
	return {
		surface: "quick_chat",
		question: "",
		mode: "read_only",
		anchors: [
			{
				kind: "selection",
				paperPath: thread.paperPath || undefined,
				page: thread.anchor.page,
				quote: thread.anchor.quote,
				translation,
			},
		],
	};
}

/** Vault text Quick Chat. Web and plaza items are not vault sources. */
export function textAskContextRequest(
	thread: PdfAskThread,
	filePath: string,
): ContextRequest {
	return {
		surface: "quick_chat",
		question: "",
		mode: "read_only",
		anchors: [
			{
				kind: "selection",
				filePath,
				quote: thread.anchor.quote,
			},
		],
	};
}

/**
 * Sidebar turn. Selections keep their annotation numbers. @ mentions and the
 * focused file are source anchors, not instructions to read the whole file.
 * Plaza mentions stay on the prompt path.
 */
export function sidebarContextRequest(input: {
	text: string;
	contextPaths: string[];
	selections: SelectionContext[];
}): ContextRequest | null {
	const numbers = new Map<string, number>();
	for (const ref of planAnnotationRefs(input.text)) {
		if (ref.kind === "selection") numbers.set(ref.selection.id, ref.n);
	}
	const anchors: ContextAnchor[] = input.selections.map((selection) =>
		selectionAnchor(selection, numbers.get(selection.id)),
	);
	for (const path of input.contextPaths) {
		if (!path.trim() || isPlazaMentionPath(path)) continue;
		anchors.push({ kind: "mention", filePath: path });
	}
	if (!anchors.length) return null;
	return {
		surface: "sidebar",
		question: "",
		mode: "read_only",
		anchors,
	};
}
