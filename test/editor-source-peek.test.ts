import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	canOpenActiveMarkdownSourcePeek,
	markdownSourcePeekPathForTab,
	openActiveMarkdownSourcePeek,
	registerMarkdownSourcePeek,
} from "@/lib/markdown/source-peek-registry";
import { setActiveTabId, setTabs } from "@/lib/workspace/store";
import { createPlaceholderTab, type DocTab } from "@/lib/workspace/tabs";

function makeTab(path: string, overrides: Partial<DocTab> = {}): DocTab {
	return { ...createPlaceholderTab(path), ...overrides };
}

function activate(tab: DocTab): void {
	setTabs([tab]);
	setActiveTabId(tab.id);
}

const disposers: Array<() => void> = [];

function registerPeek(path: string, open: () => void): () => void {
	const dispose = registerMarkdownSourcePeek(path, { open });
	disposers.push(dispose);
	return dispose;
}

beforeEach(() => {
	setTabs([]);
	setActiveTabId(null);
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

describe("Markdown source peek path resolution", () => {
	it("uses the tab's own path for a plain Markdown note", () => {
		expect(
			markdownSourcePeekPathForTab(
				makeTab("/vault/notes/idea.md", { mode: "markdown" }),
			),
		).toBe("/vault/notes/idea.md");
	});

	it("uses the NOTES.md companion of a paper notes tab", () => {
		const tab = makeTab("/vault/papers/a", {
			mode: "markdown",
			notesPath: "/vault/papers/a/NOTES.md",
		});
		expect(markdownSourcePeekPathForTab(tab)).toBe("/vault/papers/a/NOTES.md");
	});

	it("ignores panels that do not render a Markdown note", () => {
		expect(markdownSourcePeekPathForTab(null)).toBeNull();
		expect(
			markdownSourcePeekPathForTab(makeTab("/vault/a.pdf", { mode: "pdf" })),
		).toBeNull();
		expect(
			markdownSourcePeekPathForTab(
				makeTab("/vault/diagram.excalidraw", { mode: "markdown" }),
			),
		).toBeNull();
	});
});

describe("Markdown source peek registry", () => {
	it("opens the registered peek for the active Markdown tab", () => {
		const open = vi.fn();
		const tab = makeTab("/vault/notes/idea.md", { mode: "markdown" });
		activate(tab);
		const unregister = registerPeek(tab.path, open);

		expect(canOpenActiveMarkdownSourcePeek()).toBe(true);
		expect(openActiveMarkdownSourcePeek()).toBe(true);
		expect(open).toHaveBeenCalledTimes(1);

		unregister();
		expect(canOpenActiveMarkdownSourcePeek()).toBe(false);
		expect(openActiveMarkdownSourcePeek()).toBe(false);
	});

	it("resolves the NOTES.md peek of an active paper notes tab", () => {
		const open = vi.fn();
		const tab = makeTab("/vault/papers/a", {
			mode: "markdown",
			notesPath: "/vault/papers/a/NOTES.md",
		});
		activate(tab);
		registerPeek("/vault/papers/a/NOTES.md", open);

		expect(openActiveMarkdownSourcePeek()).toBe(true);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("does not open a peek registered for another note", () => {
		const open = vi.fn();
		activate(makeTab("/vault/notes/idea.md", { mode: "markdown" }));
		registerPeek("/vault/notes/other.md", open);

		expect(canOpenActiveMarkdownSourcePeek()).toBe(false);
		expect(openActiveMarkdownSourcePeek()).toBe(false);
		expect(open).not.toHaveBeenCalled();
	});

	it("matches the same file across path separators and case", () => {
		const open = vi.fn();
		activate(makeTab("C:/Vault/Notes/Idea.md", { mode: "markdown" }));
		registerPeek("C:\\Vault\\Notes\\idea.md", open);

		expect(openActiveMarkdownSourcePeek()).toBe(true);
	});

	it("keeps the newest registration when an older editor unmounts", () => {
		const older = vi.fn();
		const newer = vi.fn();
		activate(makeTab("/vault/notes/idea.md", { mode: "markdown" }));
		const unregisterOlder = registerPeek("/vault/notes/idea.md", older);
		registerPeek("/vault/notes/idea.md", newer);

		unregisterOlder();

		expect(openActiveMarkdownSourcePeek()).toBe(true);
		expect(newer).toHaveBeenCalledTimes(1);
		expect(older).not.toHaveBeenCalled();
	});

	it("falls back to the surviving editor when the newer split clone unmounts", () => {
		const older = vi.fn();
		const newer = vi.fn();
		activate(makeTab("/vault/notes/idea.md", { mode: "markdown" }));
		registerPeek("/vault/notes/idea.md", older);
		const unregisterNewer = registerPeek("/vault/notes/idea.md", newer);

		unregisterNewer();

		expect(canOpenActiveMarkdownSourcePeek()).toBe(true);
		expect(openActiveMarkdownSourcePeek()).toBe(true);
		expect(older).toHaveBeenCalledTimes(1);
		expect(newer).not.toHaveBeenCalled();
	});
});
