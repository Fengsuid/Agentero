import { createSlateEditor, createSlatePlugin, KEYS } from "platejs";
import { describe, expect, it } from "vitest";

import { LinkPlugin } from "@/components/editor/plugins/link-plugin";

const TestParagraphPlugin = createSlatePlugin({
	key: KEYS.p,
	node: { isElement: true },
});

const TestCodeBlockPlugin = createSlatePlugin({
	key: KEYS.codeBlock,
	node: { isElement: true },
});

const TestCodeLinePlugin = createSlatePlugin({
	key: KEYS.codeLine,
	node: { isElement: true },
});

function findLink(editor: { children: unknown }) {
	const children =
		(
			editor.children as Array<{
				children: Array<Record<string, unknown>>;
			}>
		)[0]?.children ?? [];
	return children.find((c) => c.type === KEYS.a);
}

function createLinkEditor(text: string) {
	const editor = createSlateEditor({
		plugins: [TestParagraphPlugin, LinkPlugin],
		value: [{ type: "p", children: [{ text }] }],
	});
	editor.tf.select({
		anchor: { path: [0, 0], offset: text.length },
		focus: { path: [0, 0], offset: text.length },
	});
	return editor;
}

function typeLink(text: string) {
	const editor = createLinkEditor("");
	for (const character of text) editor.tf.insertText(character);
	return editor;
}

describe("Markdown link input rule", () => {
	it("converts [label](url) when typing the closing parenthesis", () => {
		const editor = createLinkEditor("[docs](https://example.com");

		editor.tf.insertText(")");

		expect(findLink(editor)).toMatchObject({
			type: KEYS.a,
			url: "https://example.com",
			children: [{ text: "docs" }],
		});
		expect(JSON.stringify(editor.children)).not.toContain(
			"[docs](https://example.com)",
		);
	});

	it("converts long GitHub issue URLs character by character", () => {
		const editor = typeLink(
			"[issue](https://github.com/poco-ai/Agentero/issues)",
		);

		expect(findLink(editor)).toMatchObject({
			type: KEYS.a,
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "issue" }],
		});
	});

	it("converts fullwidth closing parenthesis", () => {
		const editor = createLinkEditor(
			"[issue](https://github.com/poco-ai/Agentero/issues",
		);
		editor.tf.insertText("）");
		expect(findLink(editor)).toMatchObject({
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "issue" }],
		});
	});

	it.each([
		")",
		"）",
	])("converts a complete link delivered in one insertText ending %s", (close) => {
		const editor = createLinkEditor("");
		editor.tf.insertText(
			`[issue](https://github.com/poco-ai/Agentero/issues${close}`,
		);
		expect(findLink(editor)).toMatchObject({
			url: "https://github.com/poco-ai/Agentero/issues",
		});
	});

	it.each([
		"../note.md#Heading",
		"./paper%20name.pdf#page=3",
		"#section",
		"agentero-wiki:note",
		"file:///tmp/note.md",
	])("preserves local link target %s", (url) => {
		const editor = typeLink(`[target](${url})`);
		expect(findLink(editor)).toMatchObject({
			url,
			children: [{ text: "target" }],
		});
	});

	it("leaves unsafe URL schemes as literal source", () => {
		const editor = typeLink("[target](javascript:alert)");
		expect(findLink(editor)).toBeUndefined();
		expect(editor.api.string([])).toBe("[target](javascript:alert)");
	});

	it("leaves Markdown source literal in a code mark", () => {
		const editor = createLinkEditor("[docs](https://example.com");
		editor.tf.addMark(KEYS.code, true);
		editor.tf.insertText(")");
		expect(findLink(editor)).toBeUndefined();
		expect(editor.api.string([])).toBe("[docs](https://example.com)");
	});

	it("converts a link after existing text and another link", () => {
		const editor = createSlateEditor({
			plugins: [TestParagraphPlugin, LinkPlugin],
			value: [
				{
					type: "p",
					children: [
						{ text: "see " },
						{
							type: KEYS.a,
							url: "https://a.com",
							children: [{ text: "a" }],
						},
						{
							text: " then [issue](https://github.com/poco-ai/Agentero/issues",
						},
					],
				},
			],
		});
		const tail = " then [issue](https://github.com/poco-ai/Agentero/issues"
			.length;
		editor.tf.select({
			anchor: { path: [0, 2], offset: tail },
			focus: { path: [0, 2], offset: tail },
		});
		editor.tf.insertText(")");

		const links = (
			editor.children[0] as { children: Array<Record<string, unknown>> }
		).children.filter((c) => c.type === KEYS.a);
		expect(links).toHaveLength(2);
		expect(links[1]).toMatchObject({
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "issue" }],
		});
	});

	it("converts while typing the full sequence character by character", () => {
		const editor = typeLink("[hello](https://example.org)");

		expect(findLink(editor)).toMatchObject({
			type: KEYS.a,
			url: "https://example.org",
			children: [{ text: "hello" }],
		});
	});

	it("leaves incomplete or bare parentheses alone", () => {
		const incomplete = createLinkEditor("[label](not-closed");
		incomplete.tf.insertText("x");
		expect(incomplete.children).toMatchObject([
			{ type: "p", children: [{ text: "[label](not-closedx" }] },
		]);

		const bare = createLinkEditor("foo(");
		bare.tf.insertText(")");
		expect(bare.children).toMatchObject([
			{ type: "p", children: [{ text: "foo()" }] },
		]);
	});

	it("removes an emptied link without leaving a shell node", () => {
		const editor = typeLink("[a](https://ex.com)");
		const linkPath = [0, 1];
		editor.tf.select({
			anchor: { path: [...linkPath, 0], offset: 0 },
			focus: { path: [...linkPath, 0], offset: 1 },
		});
		editor.tf.deleteFragment();
		editor.tf.normalize({ force: true });

		const flat = JSON.stringify(editor.children);
		expect(flat).not.toContain(`"type":"${KEYS.a}"`);
	});

	it("does not convert inside a code block", () => {
		const editor = createSlateEditor({
			plugins: [
				TestParagraphPlugin,
				LinkPlugin,
				TestCodeBlockPlugin,
				TestCodeLinePlugin,
			],
			value: [
				{
					type: KEYS.codeBlock,
					children: [
						{
							type: KEYS.codeLine,
							children: [{ text: "[a](https://example.com" }],
						},
					],
				},
			],
		});
		editor.tf.select({
			anchor: { path: [0, 0, 0], offset: "[a](https://example.com".length },
			focus: { path: [0, 0, 0], offset: "[a](https://example.com".length },
		});

		editor.tf.insertText(")");

		expect(editor.children).toMatchObject([
			{
				type: KEYS.codeBlock,
				children: [
					{
						type: KEYS.codeLine,
						children: [{ text: "[a](https://example.com)" }],
					},
				],
			},
		]);
	});

	it("removes a link emptied by Backspace and restores it with undo", () => {
		const editor = typeLink("[a](https://ex.com)");
		editor.tf.select({ path: [0, 1, 0], offset: 1 });
		editor.tf.withNewBatch(() => editor.tf.deleteBackward("character"));
		expect(findLink(editor)).toBeUndefined();
		editor.tf.undo();
		expect(findLink(editor)).toMatchObject({
			url: "https://ex.com",
			children: [{ text: "a" }],
		});
	});
});
