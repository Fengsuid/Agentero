import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import {
	createSlateEditor,
	createSlatePlugin,
	KEYS,
	type TElement,
} from "platejs";
import { describe, expect, it } from "vitest";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import {
	isBlankParagraph,
	isElementBlockSelected,
	resolveHandleBlocks,
	selectCurrentBlockThenAll,
	selectElementAsBlocks,
	selectedBlockIds,
	serializeBlocksAsMarkdown,
} from "@/lib/markdown/block-selection";

const TestParagraphPlugin = createSlatePlugin({
	key: KEYS.p,
	node: { isElement: true },
});

describe("Markdown block selection serialize", () => {
	it("serializes selected nodes as Markdown without Plate ids", () => {
		const editor = createSlateEditor({
			plugins: MarkdownKit,
			value: [
				{
					id: "block-a",
					type: "p",
					children: [{ text: "First" }],
				},
				{
					id: "block-b",
					type: "h2",
					children: [{ text: "Heading" }],
				},
			],
		});

		const markdown = serializeBlocksAsMarkdown(editor, [
			editor.children[0],
			editor.children[1],
		]);
		expect(markdown).toContain("First");
		expect(markdown).toContain("## Heading");
		expect(markdown).not.toContain("block-a");
		expect(markdown).not.toContain("id=");
	});

	it("selects a top-level block by id", () => {
		const editor = createSlateEditor({
			plugins: [...MarkdownKit, BlockSelectionPlugin],
			value: [
				{
					id: "block-a",
					type: "p",
					children: [{ text: "Hello" }],
				},
			],
		});
		const nodes = selectElementAsBlocks(editor, editor.children[0] as TElement);
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ id: "block-a" });
		expect(
			editor.getOption(BlockSelectionPlugin, "selectedIds")?.has("block-a"),
		).toBe(true);
	});

	it("keeps a multi-block selection when the handle belongs to it", () => {
		const editor = createSlateEditor({
			plugins: [...MarkdownKit, BlockSelectionPlugin],
			value: [
				{ id: "a", type: "p", children: [{ text: "A" }] },
				{ id: "b", type: "p", children: [{ text: "B" }] },
			],
		});
		editor.getApi(BlockSelectionPlugin).blockSelection.set(["a", "b"]);
		expect(isElementBlockSelected(editor, editor.children[1] as TElement)).toBe(
			true,
		);
		const nodes = resolveHandleBlocks(editor, editor.children[1] as TElement);
		expect(nodes.map((node) => node.id)).toEqual(["a", "b"]);
		expect(
			editor.getOption(BlockSelectionPlugin, "selectedIds")?.has("a"),
		).toBe(true);
		expect(
			editor.getOption(BlockSelectionPlugin, "selectedIds")?.has("b"),
		).toBe(true);
	});

	it("treats empty and whitespace paragraphs as blank lines, not content blocks", () => {
		expect(isBlankParagraph({ type: "p", children: [{ text: "" }] })).toBe(
			true,
		);
		expect(
			isBlankParagraph({ type: "p", children: [{ text: "  \n\t" }] }),
		).toBe(true);
		expect(
			isBlankParagraph({ type: "p", children: [{ text: "\uFEFF" }] }),
		).toBe(true);
		expect(isBlankParagraph({ type: "p", children: [{ text: "Hello" }] })).toBe(
			false,
		);
		expect(isBlankParagraph({ type: "h2", children: [{ text: "" }] })).toBe(
			false,
		);
		expect(
			isBlankParagraph({
				type: "p",
				children: [
					{
						type: "a",
						url: "https://example.com",
						children: [{ text: "" }],
					},
				],
			}),
		).toBe(false);
	});

	it("selects a Mermaid code block before the rest of the note", () => {
		const editor = createSlateEditor({
			plugins: [
				TestParagraphPlugin,
				CodeBlockPlugin,
				CodeLinePlugin,
				BlockSelectionPlugin,
			],
			value: [
				{
					id: "code",
					type: KEYS.codeBlock,
					lang: "mermaid",
					children: [
						{ type: KEYS.codeLine, children: [{ text: "graph TD" }] },
						{ type: KEYS.codeLine, children: [{ text: "A-->B" }] },
					],
				},
				{ id: "after", type: KEYS.p, children: [{ text: "After" }] },
			],
		});
		editor.tf.select({
			anchor: { path: [0, 1, 0], offset: 1 },
			focus: { path: [0, 1, 0], offset: 1 },
		});

		expect(selectCurrentBlockThenAll(editor)).toBe(true);
		const first = editor.api.string(editor.selection ?? []);
		expect(first).toContain("graph TD");
		expect(first).toContain("A-->B");
		expect(first).not.toContain("After");
		expect(selectedBlockIds(editor).size).toBe(0);

		expect(selectCurrentBlockThenAll(editor)).toBe(true);
		expect(selectedBlockIds(editor).has("code")).toBe(true);
		expect(selectedBlockIds(editor).has("after")).toBe(true);
	});

	it("selects an empty paragraph before the rest of the note", () => {
		const editor = createSlateEditor({
			plugins: [TestParagraphPlugin, BlockSelectionPlugin],
			value: [
				{ id: "a", type: KEYS.p, children: [{ text: "Alpha" }] },
				{ id: "empty", type: KEYS.p, children: [{ text: "" }] },
				{ id: "b", type: KEYS.p, children: [{ text: "Beta" }] },
			],
		});
		editor.tf.select({
			anchor: { path: [1, 0], offset: 0 },
			focus: { path: [1, 0], offset: 0 },
		});

		expect(selectCurrentBlockThenAll(editor)).toBe(true);
		expect([...selectedBlockIds(editor)]).toEqual(["empty"]);

		expect(selectCurrentBlockThenAll(editor)).toBe(true);
		expect(selectedBlockIds(editor).has("a")).toBe(true);
		expect(selectedBlockIds(editor).has("empty")).toBe(true);
		expect(selectedBlockIds(editor).has("b")).toBe(true);
	});

	it("selects the current paragraph before every block", () => {
		const editor = createSlateEditor({
			plugins: [TestParagraphPlugin, BlockSelectionPlugin],
			value: [
				{ id: "a", type: KEYS.p, children: [{ text: "Alpha" }] },
				{ id: "b", type: KEYS.p, children: [{ text: "Beta" }] },
			],
		});
		editor.tf.select({
			anchor: { path: [0, 0], offset: 1 },
			focus: { path: [0, 0], offset: 1 },
		});

		expect(selectCurrentBlockThenAll(editor)).toBe(true);
		expect(editor.api.string(editor.selection ?? [])).toBe("Alpha");
		expect(selectedBlockIds(editor).size).toBe(0);
	});

	it("round-trips a document without writing block ids", () => {
		const editor = createSlateEditor({
			plugins: MarkdownKit,
			value: [
				{
					id: "keep-off-disk",
					type: "p",
					children: [{ text: "Hello" }],
				},
			],
		});
		const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
		expect(markdown.trim()).toBe("Hello");
	});
});
