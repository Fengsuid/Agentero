const INLINE_TOKEN_RE = /\{\{(?:m|s|c|sel|vis):[^}]+\}\}/;
const TRAILING_INLINE_TRIGGER_RE = /(^|\s)[@/$][^\s]*$/;

export type ComposerExternalValueSyncDecision = "apply" | "skip" | "defer";

export type ComposerExternalValueSyncInput = {
	nextValue: string;
	lastKnownDomValue: string | null;
	currentDomValue: string;
	focused: boolean;
	composing: boolean;
	awaitingParentEcho: boolean;
};

function looksLikeInlineTokenCommit(
	currentDomValue: string,
	nextValue: string,
): boolean {
	return (
		INLINE_TOKEN_RE.test(nextValue) &&
		TRAILING_INLINE_TRIGGER_RE.test(currentDomValue)
	);
}

const REFERENCE_MARKER_RE = /\{\{(?:sel|vis):[^}]+\}\}/g;

function selectionMarkerCount(text: string): number {
	return text.match(REFERENCE_MARKER_RE)?.length ?? 0;
}

function proseWithoutSelectionMarkers(text: string): string {
	// Drop the spaces insertTokensAt adds around a marker, so a quote pinned
	// into the middle of a word still counts as the same prose.
	return text.replace(REFERENCE_MARKER_RE, "").replace(/\s+/g, "");
}

/**
 * A pin landed in the controlled draft while the field still shows the prose
 * it was inserted into. Applying keeps the new quote or visual reference; a
 * draft whose words differ is left alone so an in-flight keystroke is not
 * replaced.
 */
function looksLikeIncomingSelection(
	currentDomValue: string,
	nextValue: string,
): boolean {
	if (
		selectionMarkerCount(nextValue) <= selectionMarkerCount(currentDomValue)
	) {
		return false;
	}
	return (
		proseWithoutSelectionMarkers(nextValue) ===
		proseWithoutSelectionMarkers(currentDomValue)
	);
}

/**
 * Decide whether a controlled Composer value may rebuild the contenteditable DOM.
 *
 * The inline composer has to render external state changes for saved drafts,
 * history recall and mention / skill / command chip commits. But WebView IME /
 * dictation text can exist in the DOM before React has received a stable input
 * echo. Rebuilding in that window drops the first dictated/composed phrase, so
 * user-owned DOM wins unless the incoming value is the expected parent echo or a
 * token commit.
 */
export function decideComposerExternalValueSync({
	nextValue,
	lastKnownDomValue,
	currentDomValue,
	focused,
	composing,
	awaitingParentEcho,
}: ComposerExternalValueSyncInput): ComposerExternalValueSyncDecision {
	if (nextValue === lastKnownDomValue) return "skip";
	if (composing) return "defer";
	if (!focused) return "apply";

	const domChangedSinceLastSync = currentDomValue !== (lastKnownDomValue ?? "");
	const userOwnedDom =
		(awaitingParentEcho || domChangedSinceLastSync) &&
		nextValue !== currentDomValue;

	if (!userOwnedDom) return "apply";
	if (looksLikeInlineTokenCommit(currentDomValue, nextValue)) return "apply";
	if (looksLikeIncomingSelection(currentDomValue, nextValue)) return "apply";
	return "defer";
}
