import { KEYS, RangeApi, type SlateEditor } from "platejs";
import { isLiteralTextContext } from "@/lib/markdown/input-context";

/** True when the `$` at `index` is preceded by an odd number of backslashes. */
function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}

/**
 * The single `$…$` pair that encloses `offset` inside one text leaf, if any.
 * The caret must be strictly between the delimiters and no other `$` may sit
 * between them (so `$a$b$` is ambiguous and left alone).
 */
function enclosingDollarPair(
	text: string,
	offset: number,
): { open: number; close: number } | null {
	const open = text.lastIndexOf("$", offset - 1);
	if (open < 0) return null;
	const close = text.indexOf("$", offset);
	if (close < 0) return null;
	if (text.indexOf("$", open + 1) !== close) return null;
	if (isEscaped(text, open) || isEscaped(text, close)) return null;
	return { open, close };
}

/**
 * Commit-time inline-math recognition.
 *
 * The `$…$` input rule converts on the closing `$` keystroke, so typing both
 * delimiters first and then filling the middle (`$|$` → `$x_0|$`) is never
 * recognized. This converts a complete pair around the caret when the user
 * signals they are done — Enter or leaving the editor (blur).
 *
 * The inline equation is a void node edited through its popover, so it cannot
 * be converted per keystroke (the first character would end the run).
 */
export function convertInlineMathAtCaret(editor: SlateEditor): boolean {
	const selection = editor.selection;
	if (!selection || !RangeApi.isCollapsed(selection)) return false;
	if (isLiteralTextContext(editor)) return false;
	const entry = editor.api.node(selection.anchor.path);
	if (!entry) return false;
	const [node, path] = entry as [{ text?: unknown }, number[]];
	if (typeof node.text !== "string") return false;
	const pair = enclosingDollarPair(node.text, selection.anchor.offset);
	if (!pair) return false;
	const content = node.text.slice(pair.open + 1, pair.close);
	if (!content || /[\n$]/.test(content)) return false;

	const inlineType = editor.getType(KEYS.inlineEquation);
	editor.tf.withoutNormalizing(() => {
		editor.tf.delete({
			at: {
				anchor: { path, offset: pair.open },
				focus: { path, offset: pair.close + 1 },
			},
		});
		editor.tf.insertNodes(
			{ type: inlineType, texExpression: content, children: [{ text: "" }] },
			{ at: { path, offset: pair.open } },
		);
	});
	const equation = editor.api.above({ match: { type: inlineType } });
	const after = equation ? editor.api.after(equation[1]) : undefined;
	if (after) editor.tf.select(after);
	return true;
}
