import { LinkRules, validateUrl } from "@platejs/link";
import {
	defineInputRule,
	ElementApi,
	type InsertTextInputRule,
	KEYS,
	NodeApi,
	PathApi,
	type SlateEditor,
} from "platejs";
import { isLiteralTextContext } from "@/lib/markdown/input-context";

const OPEN_LINK = /\[([^\]\n]+)\]\($/;
const upstreamMarkdownRule =
	LinkRules.markdown() as InsertTextInputRule<unknown>;

/** Markdown paste must not autolink a URL while its surrounding source is open. */
export function isUnfinishedMarkdownLinkContext(editor: SlateEditor): boolean {
	if (
		!editor.selection ||
		isLiteralTextContext(editor) ||
		!editor.api.isCollapsed()
	)
		return false;
	const range = editor.api.range("start", editor.selection);
	return Boolean(
		range && /!?\[[^\]\n]*\]\([^)\n]*$/.test(editor.api.string(range)),
	);
}

/** Rich clipboard content can contain a URL node immediately after `[label](`. */
function pastedUrlAfterOpener(editor: SlateEditor) {
	let entry = editor.api.above({ match: { type: editor.getType(KEYS.a) } });
	if (!entry && editor.selection?.anchor.offset === 0) {
		const previous = PathApi.previous(editor.selection.anchor.path);
		const candidate = previous ? editor.api.node(previous) : undefined;
		if (
			candidate &&
			ElementApi.isElement(candidate[0]) &&
			candidate[0].type === editor.getType(KEYS.a)
		) {
			entry = [candidate[0], candidate[1]];
		}
	}
	if (!entry) return;
	const [node, path] = entry;
	const start = editor.api.start(path);
	const before = start ? editor.api.range("start", start) : undefined;
	if (!before || !OPEN_LINK.test(editor.api.string(before))) return;
	const url = typeof node.url === "string" ? node.url : NodeApi.string(node);
	if (!validateUrl(editor, url)) return;
	return { path, url };
}

type LinkMatch =
	| { upstream: unknown }
	| { pasted: NonNullable<ReturnType<typeof pastedUrlAfterOpener>> };

/** Upstream owns parsing, insertion and caret placement; adapt IME and rich paste. */
export const markdownLinkInputRule = defineInputRule<LinkMatch>({
	target: "insertText",
	trigger: [")", "）"],
	priority: 120,
	enabled: ({ editor }) => !isLiteralTextContext(editor),
	resolve(context) {
		if (
			context.options?.at ||
			!context.editor.api.isCollapsed() ||
			(context.text !== ")" && context.text !== "）")
		)
			return;
		const upstream = upstreamMarkdownRule.resolve?.({ ...context, text: ")" });
		if (upstream !== undefined) return { upstream };
		const pasted = pastedUrlAfterOpener(context.editor);
		if (pasted) return { pasted };
	},
	apply(context, match) {
		const normalizedContext = { ...context, text: ")" };
		if ("upstream" in match)
			return upstreamMarkdownRule.apply(normalizedContext, match.upstream);
		const { editor } = context;
		editor.tf.withoutNormalizing(() => {
			const { path, url } = match.pasted;
			editor.tf.removeNodes({ at: path });
			editor.tf.insertNodes({ text: url }, { at: path });
			editor.tf.select({ path, offset: url.length });
			const upstream = upstreamMarkdownRule.resolve?.(normalizedContext);
			if (upstream !== undefined)
				upstreamMarkdownRule.apply(normalizedContext, upstream);
			else context.insertText(context.text, context.options);
		});
		return true;
	},
});
