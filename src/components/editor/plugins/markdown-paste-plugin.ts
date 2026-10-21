import {
	createSlatePlugin,
	ElementApi,
	KEYS,
	type SlateEditor,
	TextApi,
} from "platejs";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import { isLiteralTextContext } from "@/lib/markdown/input-context";
import { isUnfinishedMarkdownLinkContext } from "@/lib/markdown/link-input-rule";

type InsertFragmentNodes = Parameters<SlateEditor["tf"]["insertFragment"]>[0];

// Slate decodes clipboard JSON but does not validate its descendants. Validate
// before inserting so a malformed nested node cannot leave a partial edit.
function isFragmentNode(node: unknown): boolean {
	return (
		TextApi.isText(node) ||
		(ElementApi.isElement(node) && node.children.every(isFragmentNode))
	);
}

function insertFragmentPreservingBlock(
	editor: SlateEditor,
	fragment: InsertFragmentNodes,
) {
	if (!fragment.length) return;

	const first = fragment[0];
	if (ElementApi.isElement(first) && first.type === editor.getType(KEYS.p)) {
		// Insert inline children so Slate preserves the current heading, list or
		// blockquote instead of replacing an empty block with a paragraph.
		if (fragment.length === 1) {
			editor.tf.insertFragment(first.children);
			return;
		}

		const currentBlock = editor.api.above({
			match: (node) => editor.api.isBlock(node),
		})?.[0];
		if (
			currentBlock &&
			typeof currentBlock.type === "string" &&
			editor.api.isEmpty(currentBlock) &&
			currentBlock.type !== editor.getType(KEYS.p)
		) {
			first.type = currentBlock.type;
		}
	}

	editor.tf.insertFragment(fragment);
}

/**
 * Parse clipboard text as Markdown before Plate's HTML parser can claim a
 * payload that contains both text/plain and text/html.
 *
 * Exception: when the caret is mid `[label](…)` construction, insert plain
 * text so a bare URL is not turned into an autolink node that breaks the
 * surrounding Markdown link syntax.
 */
export const MarkdownPastePlugin = createSlatePlugin({
	key: "markdownPaste",
}).overrideEditor(({ editor, tf: { insertData, insertFragment } }) => {
	// Let Slate own both clipboard encodings. Capture its decoded fragment before
	// inserting, so malformed payloads cannot partially edit the document and our
	// heading-preservation policy applies equally to native and Markdown paste.
	let captured: InsertFragmentNodes | null | undefined;
	const readClipboardFragment = (dataTransfer: DataTransfer) => {
		if (
			!dataTransfer.getData("application/x-slate-fragment") &&
			!dataTransfer.getData("text/html")
		)
			return null;
		captured = null;
		try {
			editor.tf.insertFragmentData(dataTransfer);
			return captured;
		} catch {
			return null;
		} finally {
			captured = undefined;
		}
	};
	return {
		transforms: {
			insertFragment(fragment, options) {
				if (captured !== undefined) {
					if (
						Array.isArray(fragment) &&
						fragment.length > 0 &&
						fragment.every(isFragmentNode)
					)
						captured = fragment;
					return;
				}
				insertFragment(fragment, options);
			},
			insertData(dataTransfer) {
				const markdown = dataTransfer.getData("text/plain");
				if (!markdown || dataTransfer.files.length > 0) {
					return insertData(dataTransfer);
				}
				if (isLiteralTextContext(editor)) {
					// Bypass Markdown/HTML parsers while retaining Slate's multiline
					// text insertion (including code-line breaks and current marks).
					editor.tf.insertTextData(dataTransfer);
					return;
				}

				// Unfinished `[label](` — keep paste as literal characters so typing
				// `)` can convert the whole thing into one link node.
				// Only for single-line payloads (multi-line stays Markdown).
				if (
					!markdown.includes("\n") &&
					isUnfinishedMarkdownLinkContext(editor)
				) {
					editor.tf.insertText(markdown);
					return;
				}

				// Intra-editor paste: when the clipboard carries a rich Slate fragment
				// (via application/x-slate-fragment or data-slate-fragment in HTML),
				// insert the exact AST nodes directly. This preserves block types (e.g.
				// headings, lists), prevents wikilink text duplication, and avoids
				// spurious empty paragraphs from DOM text extraction.
				const slateFragment = readClipboardFragment(dataTransfer);
				if (slateFragment) {
					insertFragmentPreservingBlock(editor, slateFragment);
					return;
				}

				const fragment = deserializeMarkdownBody(editor, markdown);
				if (fragment.length === 0) return insertData(dataTransfer);

				insertFragmentPreservingBlock(editor, fragment);

				const inlineEquationEntry = editor.api.above({
					match: { type: editor.getType(KEYS.inlineEquation) },
				});
				const afterEquation = inlineEquationEntry
					? editor.api.after(inlineEquationEntry[1])
					: undefined;
				if (afterEquation) editor.tf.select(afterEquation);
			},
		},
	};
});
