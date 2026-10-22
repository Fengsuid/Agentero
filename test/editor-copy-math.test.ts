import { KEYS, type SlateEditor, type TRange } from "platejs";
import { describe, expect, it } from "vitest";

import {
	mathClipboardPayload,
	mathNodeMarkdown,
	serializeSelectionAsMarkdown,
} from "@/lib/markdown/selection-markdown";

const inlineMath = {
	type: KEYS.inlineEquation,
	texExpression: "x^{2}+\\frac{a}{b}",
	children: [{ text: "" }],
};
const blockMath = {
	type: KEYS.equation,
	texExpression: "\\sum_{k=1}^{n}\\alpha_k",
	children: [{ text: "" }],
};

/** Minimal editor stub: only the query/serialize surface the helpers touch. */
function stubEditor({
	nodes = [] as unknown[],
	above = undefined as [unknown, number[]] | undefined,
	serialized = "SERIALIZED",
	selection = null as TRange | null,
} = {}): SlateEditor {
	return {
		selection,
		api: {
			nodes: () => nodes.map((node, index) => [node, [index]]),
			above: () => above,
			fragment: () => nodes,
		},
		getApi: () => ({ markdown: { serialize: () => serialized } }),
	} as unknown as SlateEditor;
}

function expandedSelection(): TRange {
	return {
		anchor: { path: [0, 0], offset: 0 },
		focus: { path: [0, 2], offset: 1 },
	};
}

describe("mathNodeMarkdown", () => {
	it("wraps inline equations in single dollars", () => {
		expect(mathNodeMarkdown(inlineMath)).toBe("$x^{2}+\\frac{a}{b}$");
	});

	it("wraps display equations in fences", () => {
		expect(mathNodeMarkdown(blockMath)).toBe(
			"$$\n\\sum_{k=1}^{n}\\alpha_k\n$$",
		);
	});

	it("trims the TeX source and ignores non-math / empty nodes", () => {
		expect(
			mathNodeMarkdown({ type: KEYS.inlineEquation, texExpression: "  x  " }),
		).toBe("$x$");
		expect(
			mathNodeMarkdown({ type: KEYS.inlineEquation, texExpression: "   " }),
		).toBe(null);
		expect(mathNodeMarkdown({ type: KEYS.p, children: [] })).toBe(null);
		expect(mathNodeMarkdown(undefined)).toBe(null);
	});
});

describe("serializeSelectionAsMarkdown", () => {
	it("serializes the fragment of an expanded selection", () => {
		const editor = stubEditor({
			nodes: [inlineMath],
			serialized: "SERIALIZED",
		});
		expect(serializeSelectionAsMarkdown(editor, expandedSelection())).toBe(
			"SERIALIZED",
		);
	});

	it("is empty for a collapsed selection or empty fragment", () => {
		const collapsed: TRange = {
			anchor: { path: [0, 0], offset: 1 },
			focus: { path: [0, 0], offset: 1 },
		};
		expect(serializeSelectionAsMarkdown(stubEditor(), collapsed)).toBe("");
		expect(serializeSelectionAsMarkdown(stubEditor(), null)).toBe("");
	});
});

describe("mathClipboardPayload", () => {
	it("copies an expanded selection that contains math as Markdown", () => {
		const editor = stubEditor({ nodes: [inlineMath], serialized: "text $x$" });
		expect(mathClipboardPayload(editor, expandedSelection())).toEqual({
			markdown: "text $x$",
		});
	});

	it("keeps the default plain-text copy when the selection has no math", () => {
		const editor = stubEditor({ nodes: [{ text: "plain" }] });
		expect(mathClipboardPayload(editor, expandedSelection())).toBe(null);
	});

	it("copies the whole equation when the caret sits inside it", () => {
		const editor = stubEditor({ above: [inlineMath, [0, 1]] });
		expect(
			mathClipboardPayload(editor, {
				anchor: { path: [0, 1, 0], offset: 0 },
				focus: { path: [0, 1, 0], offset: 0 },
			}),
		).toEqual({ markdown: "$x^{2}+\\frac{a}{b}$", path: [0, 1] });
	});
});
