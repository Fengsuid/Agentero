import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	flushMarkdownScrollMemory,
	getMarkdownScrollAnchor,
	getMarkdownScrollTop,
	MARKDOWN_SCROLL_MEMORY_LIMIT,
	markdownScrollTopToRestore,
	resetMarkdownScrollMemoryForTests,
	setMarkdownScrollTop,
} from "@/lib/markdown/scroll-memory";

const STORAGE_KEY = "agentero-md-scroll";

function memoryStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
	};
}

function stored(): Record<string, { top: number; max: number }> {
	const raw = localStorage.getItem(STORAGE_KEY);
	return raw
		? (JSON.parse(raw) as Record<string, { top: number; max: number }>)
		: {};
}

describe("markdown scroll memory", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("localStorage", memoryStorage());
		resetMarkdownScrollMemoryForTests();
	});

	afterEach(() => {
		resetMarkdownScrollMemoryForTests();
		vi.useRealTimers();
	});

	it("restores a position after the in-memory map is dropped", () => {
		setMarkdownScrollTop("notes/a.md", 812.4, 2400.2);
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
		vi.advanceTimersByTime(399);
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
		vi.advanceTimersByTime(1);
		expect(stored()).toEqual({ "notes/a.md": { top: 812, max: 2400 } });

		resetMarkdownScrollMemoryForTests();
		expect(getMarkdownScrollAnchor("notes/a.md")).toEqual({
			top: 812,
			max: 2400,
		});
		expect(getMarkdownScrollTop("notes/a.md")).toBe(812);
	});

	it("flushes pending positions without waiting for the debounce", () => {
		setMarkdownScrollTop("notes/a.md", 40, 400);
		flushMarkdownScrollMemory();
		expect(getMarkdownScrollTop("notes/a.md")).toBe(40);
		resetMarkdownScrollMemoryForTests();
		expect(getMarkdownScrollTop("notes/a.md")).toBe(40);
	});

	it("forgets a note scrolled back to the top", () => {
		setMarkdownScrollTop("notes/a.md", 500, 2000);
		setMarkdownScrollTop("notes/a.md", 0, 2000);
		flushMarkdownScrollMemory();
		resetMarkdownScrollMemoryForTests();
		expect(getMarkdownScrollTop("notes/a.md")).toBe(0);
		expect(stored()).toEqual({});
	});

	it("drops the oldest note past the cap", () => {
		for (let i = 0; i <= MARKDOWN_SCROLL_MEMORY_LIMIT; i++) {
			setMarkdownScrollTop(`notes/${i}.md`, i + 10, 5000);
		}
		flushMarkdownScrollMemory();
		resetMarkdownScrollMemoryForTests();
		expect(getMarkdownScrollTop("notes/0.md")).toBe(0);
		expect(
			getMarkdownScrollTop(`notes/${MARKDOWN_SCROLL_MEMORY_LIMIT}.md`),
		).toBe(MARKDOWN_SCROLL_MEMORY_LIMIT + 10);
	});

	it("ignores corrupt storage and keeps a bare number", () => {
		localStorage.setItem(STORAGE_KEY, "{");
		expect(getMarkdownScrollTop("notes/a.md")).toBe(0);

		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				"notes/a.md": 320,
				"notes/bad.md": "nope",
			}),
		);
		resetMarkdownScrollMemoryForTests();
		expect(getMarkdownScrollAnchor("notes/a.md")).toEqual({
			top: 320,
			max: 320,
		});
		expect(getMarkdownScrollTop("notes/bad.md")).toBe(0);
	});

	it("does not rewrite storage when the rounded position is unchanged", () => {
		setMarkdownScrollTop("notes/a.md", 10, 100);
		flushMarkdownScrollMemory();
		localStorage.removeItem(STORAGE_KEY);
		setMarkdownScrollTop("notes/a.md", 10.2, 100.4);
		vi.advanceTimersByTime(400);
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	it("uses the saved offset when the document is tall enough, else the same fraction", () => {
		const saved = { top: 800, max: 1000 };
		expect(markdownScrollTopToRestore(saved, 2000)).toBe(800);
		expect(markdownScrollTopToRestore(saved, 500)).toBe(400);
		expect(markdownScrollTopToRestore(saved, 0)).toBe(0);
	});
});
