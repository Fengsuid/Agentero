import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor, KEYS } from "platejs";
import { ParagraphPlugin } from "platejs/react";
import { describe, expect, it } from "vitest";
import { LinkPlugin } from "@/components/editor/plugins/link-plugin";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import { isUnfinishedMarkdownLinkContext } from "@/lib/markdown/link-input-rule";

const plugins = [ParagraphPlugin, LinkPlugin, ...MarkdownKit];

function makeEditor(text = "") {
	const editor = createSlateEditor({
		plugins,
		value: [{ type: "p", children: [{ text }] }],
	});
	editor.tf.select({
		anchor: { path: [0, 0], offset: text.length },
		focus: { path: [0, 0], offset: text.length },
	});
	return editor;
}

function findOuterLinks(editor: { children: unknown }) {
	const children =
		(
			editor.children as Array<{
				children: Array<Record<string, unknown>>;
			}>
		)[0]?.children ?? [];
	return children.filter((c) => c.type === KEYS.a);
}

describe("paste URL into unfinished markdown link", () => {
	it("detects unfinished [label]( context", () => {
		const editor = makeEditor("[xx](");
		expect(isUnfinishedMarkdownLinkContext(editor)).toBe(true);
		const plain = makeEditor("hello ");
		expect(isUnfinishedMarkdownLinkContext(plain)).toBe(false);
	});

	it("inserts bare URL as plain text when unfinished, then ) converts", () => {
		const editor = makeEditor();
		for (const c of "[xx](") editor.tf.insertText(c);

		expect(isUnfinishedMarkdownLinkContext(editor)).toBe(true);
		editor.tf.insertData({
			files: [],
			getData: (type: string) =>
				type === "text/plain"
					? "https://github.com/poco-ai/Agentero/issues"
					: "",
		} as unknown as DataTransfer);
		expect(JSON.stringify(editor.children)).not.toContain('"type":"a"');

		editor.tf.insertText(")");
		const links = findOuterLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			type: KEYS.a,
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "xx" }],
		});
	});

	it("converts when URL was already pasted as an autolink node", () => {
		const editor = makeEditor();
		for (const c of "[xx](") editor.tf.insertText(c);

		const fragment = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(
				prepareMarkdownForDeserialize(
					"https://github.com/poco-ai/Agentero/issues",
				),
			);
		editor.tf.insertFragment(fragment);

		// Upstream link normalization leaves a text point after the pasted URL.
		expect(findOuterLinks(editor)).toHaveLength(1);

		// Typing ) must fold [xx]( + autolink into one labeled link.
		editor.tf.insertText(")");

		const links = findOuterLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "xx" }],
		});
		expect(JSON.stringify(editor.children)).not.toContain("[xx](");
	});

	it("converts fullwidth ) from inside a pasted autolink", () => {
		const editor = makeEditor();
		for (const c of "[issue](") editor.tf.insertText(c);

		const fragment = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(
				prepareMarkdownForDeserialize(
					"https://github.com/poco-ai/Agentero/issues",
				),
			);
		editor.tf.insertFragment(fragment);
		editor.tf.select({
			path: [0, 1, 0],
			offset: "https://github.com/poco-ai/Agentero/issues".length,
		});
		editor.tf.insertText("）");

		const links = findOuterLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "issue" }],
		});
	});
});
