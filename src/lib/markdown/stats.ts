/** Helpers for counting words and characters in Markdown/plain text. */

const CJK_RE = /\p{Script=Han}/gu;
/**
 * Stateless copy for `.test()`. The `g`-flagged regex keeps `lastIndex`
 * between calls, so reusing it with `.test()` misclassified every other
 * CJK token as a non-CJK word run.
 */
const CJK_TEST_RE = /\p{Script=Han}/u;
const WORD_RUN_RE = /[\p{L}\p{N}]+/gu;

/** Count words in a way that works for mixed Chinese/English text.
 *  - Each CJK (Han) character counts as one word.
 *  - Each non-CJK letter/number run counts as one word.
 */
export function countWords(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	const cjk = trimmed.match(CJK_RE)?.length ?? 0;
	const others =
		trimmed.match(WORD_RUN_RE)?.filter((token) => !CJK_TEST_RE.test(token))
			.length ?? 0;
	return cjk + others;
}

/** Count characters in the raw text. */
export function countChars(text: string): number {
	return text.length;
}

type PlateNodeLike = {
	text?: unknown;
	texExpression?: unknown;
	children?: readonly unknown[];
};

/** Display text of one Plate node, keeping inline content in reading order. */
function plateNodeText(raw: unknown): string {
	if (!raw || typeof raw !== "object") return "";
	const node = raw as PlateNodeLike;
	let out = "";
	if (typeof node.text === "string") out += node.text;
	// Equation nodes are void: `NodeApi.string` skips them because the TeX
	// source lives in `texExpression`, not in a text leaf.
	if (typeof node.texExpression === "string") out += node.texExpression;
	if (Array.isArray(node.children)) {
		for (const child of node.children) out += plateNodeText(child);
	}
	return out;
}

/**
 * Concatenate a Plate document's text, math source included, one block per line.
 *
 * Word/char stats use this instead of `NodeApi.string`: the latter drops every
 * `$…$` / `$$…$$` expression, so a math-heavy note reads ~40% short in the
 * status bar and a silently truncated note can look only somewhat smaller than
 * the file on disk.
 */
export function plateDocumentText(nodes: readonly unknown[]): string {
	return nodes.map((node) => plateNodeText(node)).join("\n");
}
