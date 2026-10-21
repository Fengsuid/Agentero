/**
 * Per-file Markdown scroll position.
 *
 * The editor keep-alive LRU evicts older notes; without this, reopening one
 * restarts at the top. The same record is written to localStorage so a restarted
 * app opens the note where it was left. Keyed by file path, bounded, and never
 * triggers React updates (read on mount, written from a passive scroll handler).
 *
 * `top` is the pixel offset. `max` is the scroll range at save time
 * (`scrollHeight - clientHeight`). Restore uses `top` when the document is
 * still tall enough, and otherwise the same fraction of the current range, so
 * a shorter first layout (window resize, or offscreen blocks not yet measured)
 * does not clamp the view to the bottom.
 */

import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

const STORAGE_KEY = "agentero-md-scroll";
export const MARKDOWN_SCROLL_MEMORY_LIMIT = 64;
const SAVE_MS = 400;

export type MarkdownScrollAnchor = {
	top: number;
	max: number;
};

const memory = new Map<string, MarkdownScrollAnchor>();
let hydrated = false;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hideFlushInstalled = false;

function isAnchor(value: unknown): value is MarkdownScrollAnchor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as { top?: unknown; max?: unknown };
	return (
		typeof record.top === "number" &&
		Number.isFinite(record.top) &&
		record.top > 0 &&
		typeof record.max === "number" &&
		Number.isFinite(record.max)
	);
}

/** @returns true when an older entry was dropped to stay within the cap. */
function remember(key: string, anchor: MarkdownScrollAnchor): boolean {
	memory.delete(key);
	memory.set(key, {
		top: Math.round(anchor.top),
		max: Math.max(Math.round(anchor.top), Math.round(anchor.max)),
	});
	let trimmed = false;
	while (memory.size > MARKDOWN_SCROLL_MEMORY_LIMIT) {
		const oldest = memory.keys().next().value;
		if (typeof oldest !== "string") break;
		memory.delete(oldest);
		trimmed = true;
	}
	return trimmed;
}

function hydrate(): void {
	if (hydrated) return;
	hydrated = true;
	ensureHideFlush();
	const parsed = readJsonStorage<unknown>(STORAGE_KEY, null);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
	const entries = Object.entries(parsed as Record<string, unknown>);
	let kept = 0;
	let trimmed = false;
	for (const [key, value] of entries) {
		if (!key) continue;
		// A bare number is the offset alone; fraction falls back to it.
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			kept += 1;
			trimmed = remember(key, { top: value, max: value }) || trimmed;
			continue;
		}
		if (!isAnchor(value)) continue;
		kept += 1;
		trimmed = remember(key, value) || trimmed;
	}
	// Drop junk and entries over the cap on the next write, not on every launch.
	if (trimmed || kept !== entries.length) scheduleSave();
}

function ensureHideFlush(): void {
	if (hideFlushInstalled || typeof window === "undefined") return;
	hideFlushInstalled = true;
	window.addEventListener("pagehide", flushMarkdownScrollMemory);
	window.addEventListener("beforeunload", flushMarkdownScrollMemory);
}

function scheduleSave(): void {
	dirty = true;
	ensureHideFlush();
	if (saveTimer != null) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		flushMarkdownScrollMemory();
	}, SAVE_MS);
}

/** Write any pending positions. Also runs on page hide so quit does not wait. */
export function flushMarkdownScrollMemory(): void {
	if (saveTimer != null) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	if (!dirty) return;
	if (writeJsonStorage(STORAGE_KEY, Object.fromEntries(memory))) dirty = false;
}

export function getMarkdownScrollAnchor(
	key: string,
): MarkdownScrollAnchor | null {
	hydrate();
	return memory.get(key) ?? null;
}

export function getMarkdownScrollTop(key: string): number {
	return getMarkdownScrollAnchor(key)?.top ?? 0;
}

/**
 * Pixel offset to apply for a saved anchor. Exact when the document is still
 * tall enough; otherwise the same fraction of `viewportMax`.
 */
export function markdownScrollTopToRestore(
	saved: MarkdownScrollAnchor,
	viewportMax: number,
): number {
	if (!Number.isFinite(viewportMax) || viewportMax <= 0) return 0;
	if (viewportMax + 1 >= saved.top) return saved.top;
	if (saved.max <= 0) return Math.min(saved.top, viewportMax);
	return (saved.top / saved.max) * viewportMax;
}

export function setMarkdownScrollTop(
	key: string,
	top: number,
	max: number,
): void {
	if (!key) return;
	hydrate();
	if (!Number.isFinite(top) || top <= 0) {
		if (!memory.has(key)) return;
		memory.delete(key);
		scheduleSave();
		return;
	}
	const next: MarkdownScrollAnchor = {
		top: Math.round(top),
		max: Math.max(
			Math.round(top),
			Number.isFinite(max) ? Math.round(max) : Math.round(top),
		),
	};
	if (next.top <= 0) {
		if (!memory.has(key)) return;
		memory.delete(key);
		scheduleSave();
		return;
	}
	const prev = memory.get(key);
	if (prev && prev.top === next.top && prev.max === next.max) return;
	remember(key, next);
	scheduleSave();
}

/** Drop the in-memory map so the next read comes from storage. */
export function resetMarkdownScrollMemoryForTests(): void {
	memory.clear();
	hydrated = false;
	dirty = false;
	if (saveTimer != null) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
}
