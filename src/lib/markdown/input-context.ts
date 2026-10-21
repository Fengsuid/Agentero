import { KEYS, type SlateEditor, TextApi } from "platejs";

/** Toolbar and input rules require real text points, not container boundaries. */
export function hasTextSelection(editor: SlateEditor): boolean {
	if (!editor.selection) return false;
	return [editor.selection.anchor, editor.selection.focus].every((point) => {
		const node = editor.api.node(point.path)?.[0];
		return (
			TextApi.isText(node) &&
			Number.isInteger(point.offset) &&
			point.offset >= 0 &&
			point.offset <= node.text.length
		);
	});
}

/** Code and equation source must remain literal across typing, paste and blur. */
export function isLiteralTextContext(editor: SlateEditor): boolean {
	return (
		!hasTextSelection(editor) ||
		Boolean(
			editor.api.some({
				match: {
					type: [KEYS.codeBlock, KEYS.equation, KEYS.inlineEquation].map(
						(key) => editor.getType(key),
					),
				},
			}),
		) ||
		Boolean(editor.api.marks()?.[editor.getType(KEYS.code)])
	);
}
