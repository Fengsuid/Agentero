/**
 * Outline of the open TeX buffer, read from the codemirror-lang-latex
 * syntax tree (the same Lezer grammar the editor already uses for
 * highlighting and folding). Sections follow LaTeX Workshop's default
 * hierarchy. `\input` / `\include` / `\subfile` stay file rows — child
 * files are not parsed into this tree.
 */

import { joinPath } from "@/lib/core/path";

/**
 * The slice of a Lezer node this walk needs. Declared locally so the
 * outline does not depend on `@lezer/common` (it is not a direct dependency;
 * the editor's syntax tree satisfies this shape).
 */
type OutlineNode = {
	name: string;
	from: number;
	to: number;
	firstChild: OutlineNode | null;
	nextSibling: OutlineNode | null;
};

/** part → subsubsection. Paragraph and below stay out of the outline. */
const SECTION_NODES = new Set([
	"Part",
	"Chapter",
	"Section",
	"SubSection",
	"SubSubSection",
]);

const FILE_NODES = new Set(["Input", "Include", "Subfile"]);

export type TexOutlineItem = {
	id: string;
	kind: "section" | "file";
	/** Nesting under ancestor sections. Top-level rows are 0. */
	indent: number;
	title: string;
	/** 1-based line of the command. */
	line: number;
	/** Path argument as written, for file rows. */
	fileArg?: string;
};

export type TexOutlineDoc = {
	lineAt(pos: number): { number: number };
	sliceString(from: number, to: number): string;
};

function childNamed(node: OutlineNode, name: string): OutlineNode | null {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.name === name) return child;
	}
	return null;
}

function descendantNamed(node: OutlineNode, name: string): OutlineNode | null {
	const direct = childNamed(node, name);
	if (direct) return direct;
	for (let child = node.firstChild; child; child = child.nextSibling) {
		const found = descendantNamed(child, name);
		if (found) return found;
	}
	return null;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function sectionTitle(node: OutlineNode, doc: TexOutlineDoc): string {
	const command = childNamed(node, "SectioningCommand") ?? node;
	const arg = descendantNamed(command, "LongArg");
	if (arg) {
		const title = oneLine(doc.sliceString(arg.from, arg.to));
		if (title) return title;
	}
	const ctrl = command.firstChild;
	if (ctrl) return oneLine(doc.sliceString(ctrl.from, ctrl.to));
	return node.name;
}

function fileArgument(node: OutlineNode, doc: TexOutlineDoc): string {
	const literal = descendantNamed(node, "LiteralArgContent");
	if (!literal) return "";
	return doc.sliceString(literal.from, literal.to).trim();
}

function pushItem(
	out: TexOutlineItem[],
	node: OutlineNode,
	doc: TexOutlineDoc,
	indent: number,
	kind: TexOutlineItem["kind"],
	title: string,
	fileArg?: string,
) {
	out.push({
		id: `${kind}:${node.from}`,
		kind,
		indent,
		title,
		line: doc.lineAt(node.from).number,
		...(fileArg ? { fileArg } : {}),
	});
}

function walk(
	node: OutlineNode,
	doc: TexOutlineDoc,
	indent: number,
	out: TexOutlineItem[],
) {
	if (SECTION_NODES.has(node.name)) {
		pushItem(out, node, doc, indent, "section", sectionTitle(node, doc));
		// Only the body. The title argument can itself contain `\input`,
		// and that belongs in the heading text, not as its own row.
		const content = childNamed(node, "Content");
		if (content) walk(content, doc, indent + 1, out);
		return;
	}
	if (FILE_NODES.has(node.name)) {
		const fileArg = fileArgument(node, doc);
		if (fileArg) {
			pushItem(out, node, doc, indent, "file", fileArg, fileArg);
		}
		return;
	}
	for (let child = node.firstChild; child; child = child.nextSibling) {
		walk(child, doc, indent, out);
	}
}

/** Document-order outline. `root` is the parse tree's top node. */
export function texOutlineFromTree(
	root: OutlineNode,
	doc: TexOutlineDoc,
): TexOutlineItem[] {
	const items: TexOutlineItem[] = [];
	walk(root, doc, 0, items);
	return items;
}

/**
 * The last section at or above the cursor. File rows do not take the
 * highlight — the cursor is "in" the enclosing section.
 */
export function activeOutlineSectionId(
	items: readonly TexOutlineItem[],
	cursorLine: number,
): string | null {
	let id: string | null = null;
	for (const item of items) {
		if (item.kind === "section" && item.line <= cursorLine) id = item.id;
	}
	return id;
}

/**
 * Resolve an `\input` / `\include` / `\subfile` argument against the
 * file that contains the command. A missing extension becomes `.tex`.
 * The parent keeps its own separator so Windows paths stay consistent.
 */
export function resolveTexInputPath(texFile: string, arg: string): string {
	const cleaned = arg.trim().replace(/^["']|["']$/g, "");
	if (!cleaned) return "";
	const withExt = /\.[A-Za-z0-9]+$/.test(cleaned) ? cleaned : `${cleaned}.tex`;
	if (
		withExt.startsWith("/") ||
		withExt.startsWith("\\") ||
		/^[A-Za-z]:[\\/]/.test(withExt)
	) {
		return withExt;
	}
	const slash = Math.max(texFile.lastIndexOf("/"), texFile.lastIndexOf("\\"));
	const parent =
		slash < 0 ? "" : slash === 0 ? texFile[0] : texFile.slice(0, slash);
	return joinPath(parent, withExt);
}
