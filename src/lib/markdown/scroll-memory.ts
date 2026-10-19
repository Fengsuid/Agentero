/**
 * Per-file Markdown scroll position, kept for the session.
 *
 * The editor keep-alive LRU evicts older notes; without this, reopening one
 * restarts at the top. Keyed by file path, bounded, and never triggers React
 * updates (read on mount, written from a passive scroll handler / unmount).
 */
const LIMIT = 64;
const memory = new Map<string, number>();

export function getMarkdownScrollTop(key: string): number {
	return memory.get(key) ?? 0;
}

export function setMarkdownScrollTop(key: string, top: number): void {
	if (!Number.isFinite(top) || top < 0) return;
	memory.delete(key);
	memory.set(key, top);
	while (memory.size > LIMIT) {
		const oldest = memory.keys().next().value;
		if (typeof oldest !== "string") break;
		memory.delete(oldest);
	}
}
