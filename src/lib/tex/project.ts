/**
 * Which TeX project the sidebar should follow.
 *
 * Same root file as compilation (`resolveTexRoot`, LaTeX Workshop's order):
 * `% !TEX root` → the file's own `\documentclass` / `\begin{document}` →
 * a root whose `\input` / `\include` closure contains the file. The project
 * is that root file's directory, so nested chapters, figures, and the PDF
 * stay inside it. A search that finds no new root keeps the previous one,
 * which is why viewing the PDF does not dismiss the panel.
 */

import { dirnameOf, normalizePath } from "@/lib/core/path";
import { isTexPath } from "@/lib/workspace/viewer";

export type TexProject = {
	/** Buffer the outline follows. Compile still resolves this to the root. */
	texPath: string;
	/** Directory of the resolved root file. */
	rootDir: string;
};

/** `main.pdf` / `main.log` beside a source becomes `main.tex`. */
export function siblingTexPath(path: string): string | null {
	if (!/\.(pdf|log)$/i.test(path)) return null;
	return path.replace(/\.(pdf|log)$/i, ".tex");
}

export function isInsideProject(path: string, rootDir: string): boolean {
	const normalizedPath = normalizePath(path);
	const normalizedDir = normalizePath(rootDir);
	if (!normalizedDir) return false;
	return (
		normalizedPath === normalizedDir ||
		normalizedPath.startsWith(`${normalizedDir}/`)
	);
}

/**
 * Apply one lookup. `rootFile` / `resolvedFrom` are set when the active path
 * is TeX, or when a same-stem `.tex` sits next to a PDF/log. A non-TeX file
 * in the same root directory keeps the TeX the user was editing.
 */
export function reduceTexProject(
	previous: TexProject | null,
	activePath: string,
	rootFile: string | null,
	resolvedFrom: string | null,
): TexProject | null {
	if (rootFile && resolvedFrom) {
		const rootDir = dirnameOf(rootFile);
		if (
			previous &&
			!isTexPath(activePath) &&
			normalizePath(previous.rootDir) === normalizePath(rootDir)
		) {
			return previous;
		}
		if (!rootDir) return previous;
		return { texPath: resolvedFrom, rootDir };
	}
	if (previous && isInsideProject(activePath, previous.rootDir)) {
		return previous;
	}
	return null;
}
