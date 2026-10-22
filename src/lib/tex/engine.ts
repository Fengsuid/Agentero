/**
 * Which engine latexmk should call.
 *
 * The document wins (`% !TEX program` / `% !TEX TS-program` on the root
 * file). Otherwise the last choice saved for that root, then XeLaTeX when
 * it is installed. The sidebar does not ask on every compile.
 */

import { normalizePath } from "@/lib/core/path";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

const ENGINE_STORAGE_KEY = "agentero.texEngineByRoot";
const KNOWN_ENGINES = new Set(["pdflatex", "xelatex", "lualatex"]);

/** First `% !TEX program = …` / `% !TEX TS-program = …` that names an engine. */
export function parseTexProgram(content: string): string | null {
	for (const line of content.split(/\r?\n/)) {
		const match = line.match(/^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\S+)/i);
		if (!match) continue;
		const id = match[1].toLowerCase();
		if (KNOWN_ENGINES.has(id)) return id;
	}
	return null;
}

export function chooseTexEngine(opts: {
	magic: string | null;
	remembered: string | null;
	available: readonly string[];
}): string | null {
	const has = (id: string | null): id is string =>
		id != null && opts.available.includes(id);
	if (has(opts.magic)) return opts.magic;
	if (has(opts.remembered)) return opts.remembered;
	if (has("xelatex")) return "xelatex";
	return opts.available[0] ?? null;
}

export function rememberedTexEngine(rootPath: string): string | null {
	const map = readJsonStorage<Record<string, string>>(ENGINE_STORAGE_KEY, {});
	const id = map?.[normalizePath(rootPath)];
	return typeof id === "string" ? id : null;
}

export function rememberTexEngine(rootPath: string, engineId: string): void {
	const map = readJsonStorage<Record<string, string>>(ENGINE_STORAGE_KEY, {});
	writeJsonStorage(ENGINE_STORAGE_KEY, {
		...(map && typeof map === "object" ? map : {}),
		[normalizePath(rootPath)]: engineId,
	});
}
