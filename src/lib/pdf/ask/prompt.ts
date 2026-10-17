import type { PdfAskThread } from "@/lib/pdf/ask/types";

const pairedAskTranslations = new Map<string, string>();

/** Session-only translation context. Not written into the ask mark. */
export function rememberPairedAskTranslation(
	threadId: string,
	translation: string,
): void {
	const text = translation.trim().slice(0, 1000);
	if (text) pairedAskTranslations.set(threadId, text);
	else pairedAskTranslations.delete(threadId);
}

/** Translation captured for this ask thread, if the user selected a translation. */
export function pairedAskTranslation(threadId: string): string | undefined {
	return pairedAskTranslations.get(threadId);
}

/** Build a single-turn prompt for ACP (includes prior turns for multi-round). */
export function buildPdfAskPrompt(
	thread: PdfAskThread,
	latestUserQuestion: string,
): string {
	const history = thread.messages
		.filter((m) => m.role === "user" || m.role === "assistant")
		// exclude the just-appended user message if it matches latest
		.slice(0, -1)
		.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
		.join("\n\n");

	const parts = [
		"You are helping the user read a research paper PDF in Agentero.",
		"The paper ref, title, page, and quoted passage are in the research context above this question. Do not assume you can read the rest of the paper unless that context says the context tools are available.",
	];
	if (thread.anchor.visualKind === "formula") {
		parts.push(
			"The user attached a crop containing a formula or technical expression.",
			"Explain its purpose, define the notation, describe how the terms interact, and connect it to the surrounding paper. Do not invent missing context.",
		);
	} else if (thread.anchor.visualKind === "figure") {
		parts.push(
			"The user attached a crop containing a figure, chart, table, or other visual region.",
			"Explain the visual structure, axes or legend when present, the main comparison, and the conclusion supported by the crop. Do not invent unreadable values.",
		);
	}
	if (history) {
		parts.push("Earlier turns in this selection thread:", history);
	}
	const q = latestUserQuestion.trim();
	parts.push(
		"User question:",
		q || "(no text)",
		"Answer based on the quote and prior turns when possible. Be concise. If uncertain, say so.",
	);
	return parts.join("\n\n");
}

export { buildTranslatePrompt } from "@/lib/translate/prompt";
