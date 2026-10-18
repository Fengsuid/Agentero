import { normalizePath } from "@/lib/core/path";
import {
	isUnderPaperAttachments,
	paperAttachmentChildren,
	paperHasVisibleAttachments,
} from "@/lib/paper/attachments";
import type { FileNode } from "@/lib/vault/types";

type NamedChild = {
	name: string;
	kind?: string;
	path?: string;
	children?: NamedChild[];
	childrenPending?: boolean;
};

/**
 * Root-level paper documents surfaced as child rows (whitelist). Anything else
 * at the paper root (PDF, metadata.json, figures, …) stays owned by the paper
 * row itself.
 */
const PAPER_CHILD_DOC_EXTS = new Set([".md", ".html", ".htm"]);

function fileExtension(name: string): string {
	const lower = name.toLowerCase();
	const dot = lower.lastIndexOf(".");
	return dot > 0 ? lower.slice(dot) : "";
}

/** Whitelisted extension: Markdown / HTML note documents. */
export function isPaperChildDocName(name: string): boolean {
	return PAPER_CHILD_DOC_EXTS.has(fileExtension(name));
}

/**
 * Root-level Markdown/HTML children of a paper folder.
 *
 * A single document is normally the paper's own `NOTES.md` (or `PAPER.md`),
 * already represented by the paper row, so it is not surfaced. Only when the
 * folder holds more than one whitelisted document do the rows appear, so
 * imported notes and web snapshots become visible without adding a chevron to
 * every paper.
 */
export function paperRootDocChildren<T extends NamedChild>(
	paper: { children?: T[] } | null | undefined,
): T[] {
	const docs = (paper?.children ?? []).filter(
		(child) => child.kind === "file" && isPaperChildDocName(child.name),
	);
	return docs.length > 1 ? docs : [];
}

/**
 * Path is a surfaced root-level paper document (a direct child of the paper
 * folder with a whitelisted extension).
 */
export function isPaperChildDocPath(
	path: string | null,
	paperDir: string | null,
): boolean {
	if (!path || !paperDir) return false;
	const dir = normalizePath(paperDir).replace(/\/+$/, "");
	const target = normalizePath(path);
	const prefix = `${dir}/`;
	if (!target.toLowerCase().startsWith(prefix.toLowerCase())) return false;
	const rel = target.slice(prefix.length);
	return !rel.includes("/") && isPaperChildDocName(rel);
}

/** Path keeps its own tree row instead of highlighting the paper row. */
export function paperSurfacesChildPath(
	path: string | null,
	paper: FileNode,
): boolean {
	if (!path) return false;
	if (isUnderPaperAttachments(path, paper.path)) return true;
	if (!isPaperChildDocPath(path, paper.path)) return false;
	const docs = paperRootDocChildren(paper);
	const key = normalizePath(path).toLowerCase();
	return docs.some(
		(child) =>
			Boolean(child.path) &&
			normalizePath(child.path as string).toLowerCase() === key,
	);
}

/** Children shown when a paper row is expanded: root documents, then attachments. */
export function paperVisibleChildren(paper: FileNode): FileNode[] {
	const docs = paperRootDocChildren(paper);
	const attachments = paperAttachmentChildren(paper);
	if (docs.length === 0) return attachments;
	if (attachments.length === 0) return docs;
	return [...docs, ...attachments];
}

/** Whether a paper row shows an expand chevron (documents or attachments). */
export function paperHasVisibleChildren(
	paper: { children?: NamedChild[] } | null | undefined,
): boolean {
	return (
		paperRootDocChildren(paper).length > 0 || paperHasVisibleAttachments(paper)
	);
}
