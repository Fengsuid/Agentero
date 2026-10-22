// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type Diagnostic,
	forceLinting,
	forEachDiagnostic,
} from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { latex } from "codemirror-lang-latex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chktexLint = vi.hoisted(() => vi.fn());
vi.mock("@/lib/core/bindings", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/core/bindings")>();
	return { ...actual, commands: { ...actual.commands, chktexLint } };
});
vi.mock("codemirror-lang-latex", async (importOriginal) => {
	const actual = await importOriginal<typeof import("codemirror-lang-latex")>();
	return { ...actual, latex: vi.fn(actual.latex) };
});

import { textLanguageExtensions } from "@/components/viewer/text-editor-language";

let view: EditorView | null = null;
beforeEach(() => {
	vi.clearAllMocks();
	chktexLint.mockResolvedValue({ ok: true, data: [] });
});
afterEach(() => {
	view?.destroy();
	view = null;
});

function configuredEditor(source: string): EditorView {
	view = new EditorView({
		state: EditorState.create({
			doc: source,
			extensions: [
				basicSetup,
				...textLanguageExtensions("/vault/thesis/main.tex"),
			],
		}),
	});
	return view;
}

function diagnostics(editor: EditorView): Diagnostic[] {
	const result: Diagnostic[] = [];
	forEachDiagnostic(editor.state, (diagnostic) => {
		result.push(diagnostic);
	});
	return result;
}

describe("configured LaTeX editor lint", () => {
	it("runs only ChkTeX, without package or custom project checks", async () => {
		const source =
			"\\begin{document}\n\\begin{itemize}\n\\ref{undefined} \\cite{undefined}\n\\end{document}";
		const editor = configuredEditor(source);
		forceLinting(editor);
		await vi.waitFor(() => expect(chktexLint).toHaveBeenCalledOnce());
		expect(chktexLint).toHaveBeenCalledWith("/vault/thesis/main.tex", source);
		expect(latex).toHaveBeenCalledWith(
			expect.objectContaining({ enableLinting: false }),
		);
		expect(diagnostics(editor)).toEqual([]);
	});

	it("preserves native ChkTeX command-space warnings in the actual starter", async () => {
		const source = readFileSync(
			resolve("templates/vault/thesis/main.tex"),
			"utf8",
		);
		// These are the native ChkTeX 1.7.9 results for the two newblock lines.
		chktexLint.mockResolvedValue({
			ok: true,
			data: [46, 47].map((line) => ({
				line,
				column: 10,
				length: 1,
				severity: "warning",
				code: 1,
				message: "Command terminated with space.",
			})),
		});
		const editor = configuredEditor(source);
		forceLinting(editor);
		await vi.waitFor(() => expect(diagnostics(editor)).toHaveLength(2));
		expect(
			diagnostics(editor).map((diagnostic) => [
				diagnostic.source,
				diagnostic.message,
			]),
		).toEqual([
			[undefined, "Command terminated with space. (chktex 1)"],
			[undefined, "Command terminated with space. (chktex 1)"],
		]);
	});

	it("does not invent fallback diagnostics when ChkTeX is unavailable", async () => {
		chktexLint.mockRejectedValue(new Error("chktex unavailable"));
		const editor = configuredEditor(
			"\\begin{thebibliography}{9}\n\\bibitem{vaswani2017attention}\n\\newblock Attention is all you need.\n\\end{thebibliography}",
		);
		forceLinting(editor);
		await vi.waitFor(() => expect(chktexLint).toHaveBeenCalledOnce());
		expect(diagnostics(editor)).toEqual([]);
	});
});
