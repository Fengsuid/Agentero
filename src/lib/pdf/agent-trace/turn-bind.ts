/**
 * Bind disk finalizers for an Agent turn that already belongs to a visual-mark
 * pin. Composer crops are prompt context only: sending them does not create or
 * rewrite `marks/<id>.json`. A follow-up on an open pin still patches that mark.
 * Best-effort: a failed mark write never stops the chat run.
 */
import {
	beginTraceContinue,
	readPdfVisualTrace,
	writePdfVisualTrace,
} from "@/lib/pdf/agent-trace/io";
import { rememberPendingVisualTraces } from "@/lib/pdf/agent-trace/pending";

export type BindVisualTracesInput = {
	runtimeSessionId: string;
	messageId: string;
	agentId: string;
	/** Turn text appended to the pin transcript. */
	userText: string;
	/** Set only when this session was opened from that mark. */
	continueVisualTraceId?: string;
	continuePaperAbs?: string;
};

export async function bindVisualTracesForTurn({
	runtimeSessionId,
	messageId,
	agentId,
	userText,
	continueVisualTraceId,
	continuePaperAbs,
}: BindVisualTracesInput): Promise<void> {
	if (!continueVisualTraceId || !continuePaperAbs) return;
	try {
		const current = await readPdfVisualTrace(
			continuePaperAbs,
			continueVisualTraceId,
		);
		if (current) {
			const next = beginTraceContinue(current, {
				runtimeSessionId,
				messageId,
				userContent: userText,
				// Note-only marks need agentId when attaching the first thread.
				agentId: agentId || current.agent?.agentId || undefined,
			});
			await writePdfVisualTrace(continuePaperAbs, next);
		}
	} catch {
		// Keep chat running even if mark write fails.
	}
	rememberPendingVisualTraces(runtimeSessionId, [
		{
			paperAbsPath: continuePaperAbs,
			traceId: continueVisualTraceId,
		},
	]);
}
