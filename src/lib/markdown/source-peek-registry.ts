/**
 * Read-only Markdown source peek, keyed by open file path.
 *
 * Lib-layer registry (no JSX) so business logic — here the command palette —
 * can open the source peek of the active Markdown tab without React prop
 * threading and without lib importing components. Same shape as the PDF
 * viewer registry.
 *
 * The registered action only serializes the current document; it never marks
 * the note dirty or schedules autosave.
 */

import { isMarkdownPath } from "@/lib/vault/fs";
import { normalizePathKey } from "@/lib/vault/path";
import { getActiveTab } from "@/lib/workspace/store";
import { type DocTab, tabIsPaperNotes } from "@/lib/workspace/tabs";

export type MarkdownSourcePeekHandle = {
	/** Capture the current serialized source and open the read-only overlay. */
	open: () => void;
};

/**
 * One stack per path: splitting a pane can mount the same note in two editors,
 * and the newest registration is the one the palette drives. Unregistering it
 * must fall back to the still-mounted sibling instead of dropping the entry.
 */
const handlesByPath = new Map<string, MarkdownSourcePeekHandle[]>();

/** Absolute-path equality key; matches the tab-id normalization. */
function pathKey(path: string): string {
	return normalizePathKey(path.trim());
}

/** Register the source peek of one mounted editor. Returns an unregister fn. */
export function registerMarkdownSourcePeek(
	path: string,
	handle: MarkdownSourcePeekHandle,
): () => void {
	const key = pathKey(path);
	if (!key) return () => {};
	const stack = handlesByPath.get(key) ?? [];
	stack.push(handle);
	handlesByPath.set(key, stack);
	return () => {
		const current = handlesByPath.get(key);
		if (!current) return;
		const index = current.lastIndexOf(handle);
		if (index === -1) return;
		current.splice(index, 1);
		if (current.length === 0) handlesByPath.delete(key);
	};
}

/**
 * Path whose source the active tab can peek: the `NOTES.md` of a paper-notes
 * tab, or the tab's own `.md` path. Mirrors the `filePath` DocView hands the
 * editor, so palette resolution and editor registration agree.
 */
export function markdownSourcePeekPathForTab(
	tab: DocTab | null,
): string | null {
	if (tab?.mode !== "markdown") return null;
	if (tabIsPaperNotes(tab)) return tab.notesPath ?? null;
	return isMarkdownPath(tab.path) ? tab.path : null;
}

function activeMarkdownSourcePeekHandle(): MarkdownSourcePeekHandle | null {
	const path = markdownSourcePeekPathForTab(getActiveTab());
	if (!path) return null;
	const stack = handlesByPath.get(pathKey(path));
	return stack?.[stack.length - 1] ?? null;
}

/** True when the active panel is a Markdown note with a mounted editor. */
export function canOpenActiveMarkdownSourcePeek(): boolean {
	return activeMarkdownSourcePeekHandle() !== null;
}

/**
 * Open the source peek of the active Markdown note.
 * No-op (returns false) when the active panel is not a mounted Markdown note.
 */
export function openActiveMarkdownSourcePeek(): boolean {
	const handle = activeMarkdownSourcePeekHandle();
	if (!handle) return false;
	handle.open();
	return true;
}
