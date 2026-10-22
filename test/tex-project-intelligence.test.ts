// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguage } from "codemirror-lang-latex";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	persist: vi.fn(),
	load: vi.fn(),
	flush: vi.fn(),
}));

vi.mock("@/lib/tex/host", () => ({
	inspectLatexProject: vi.fn(),
}));
vi.mock("@/lib/vault/fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/vault/fs")>()),
	readVaultFile: mocks.read,
}));
vi.mock("@/lib/workspace/persistence", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/persistence")>()),
	persistTextFile: mocks.persist,
}));
vi.mock("@/lib/workspace/text-editor-flush", () => ({
	flushAllTextEditors: mocks.flush,
	flushTextEditorFor: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/tex/project-index", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/tex/project-index")>()),
	loadTexProjectIndex: mocks.load,
}));

import { parseBibEntries } from "@/lib/bibtex/parse";
import type { PaperMetadata } from "@/lib/paper/types";
import {
	addCatalogCitation,
	attachProjectBibliography,
	catalogBibEntry,
	existingCatalogCitation,
} from "@/lib/tex/catalog-citation";
import {
	insertTexCitation,
	texMathAt,
	texProjectCompletionSource,
	texReferenceContext,
	texReferenceDefinition,
} from "@/lib/tex/editor-intelligence";
import { registerTexEditor } from "@/lib/tex/editor-navigation";
import { buildTexProjectIndex, texPathKey } from "@/lib/tex/project-index";
import { parseTexBibitems } from "@/lib/tex/source";

const rootPath = "/vault/thesis/main.tex";
const chapterPath = "/vault/thesis/chapters/intro.tex";
const bibPath = "/vault/thesis/references.bib";
const paper = {
	id: "id",
	bibtex_key: "smith2026",
	title: "Research",
	authors: ["Alice Smith"],
	year: 2026,
	doi: "10.1/abc",
	arxiv_id: null,
	publication: null,
	volume: null,
	issue: null,
	pages: null,
	publisher: null,
} as PaperMetadata;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flush.mockResolvedValue(true);
});

describe("LaTeX project intelligence", () => {
	it("recognizes the actual starter bibliography for citation completion and definitions", async () => {
		const source = readFileSync(
			resolve("templates/vault/thesis/main.tex"),
			"utf8",
		);
		const info = {
			rootPath,
			candidates: [rootPath],
			texFiles: [rootPath],
			bibFiles: [],
			dependencies: [],
		};
		const index = buildTexProjectIndex(info, new Map([[rootPath, source]]));
		const entry = index.citations.find(
			(citation) => citation.key === "vaswani2017attention",
		);
		expect(entry).toMatchObject({ path: rootPath, line: 44, kind: "bibitem" });
		expect(entry?.fields.title).toContain("Attention is all you need");
		expect(
			texReferenceDefinition(index, {
				kind: "citation",
				key: "vaswani2017attention",
				from: 0,
				to: 0,
			}),
		).toMatchObject({ path: rootPath, line: 44 });
		const view = new EditorView({
			state: EditorState.create({ doc: source, extensions: [latexLanguage] }),
		});
		try {
			mocks.load.mockResolvedValue(index);
			const position =
				source.indexOf("\\cite{vaswani2017attention}") +
				"\\cite{vaswani".length;
			const result = await texProjectCompletionSource(rootPath)(
				new CompletionContext(view.state, position, true),
			);
			expect(
				result?.options.some(
					(option) => option.apply === "vaswani2017attention",
				),
			).toBe(true);
			expect(
				existingCatalogCitation(index.citations, {
					...paper,
					bibtex_key: "vaswani2017attention",
					title: "Attention Is All You Need",
					doi: null,
				}),
			).toMatchObject({ key: "vaswani2017attention" });
		} finally {
			view.destroy();
		}
	});

	it("indexes optional bibitem labels in other chapters and excludes commented or verbatim entries", () => {
		const source = [
			"% \\begin{thebibliography}{9} \\bibitem{commented} fake \\end{thebibliography}",
			"\\begin{verbatim}",
			"\\begin{thebibliography}{9} \\bibitem{verbatim} fake \\end{thebibliography}",
			"\\end{verbatim}",
			"\\begin{thebibliography}{9}",
			"% \\bibitem{also-commented} fake",
			"\\bibitem[\\protect\\citeauthoryear{Smith}{2026}]{smith2026}",
			"Alice Smith. A useful paper. 2026.",
			"\\bibitem[Other [nested] label]{other}",
			"Second paper.",
			"\\end{thebibliography}",
		].join("\n");
		expect(parseTexBibitems(source).map((entry) => entry.key)).toEqual([
			"smith2026",
			"other",
		]);
		const info = {
			rootPath,
			candidates: [rootPath],
			texFiles: [rootPath, chapterPath],
			bibFiles: [],
			dependencies: [],
		};
		const root =
			"\\begin{document}\n\\cite{smith2026}\n\\input{chapters/intro}\n\\end{document}";
		const index = buildTexProjectIndex(
			info,
			new Map([
				[rootPath, root],
				[chapterPath, source],
			]),
		);
		expect(
			texReferenceDefinition(index, {
				kind: "citation",
				key: "smith2026",
				from: 0,
				to: 0,
			}),
		).toMatchObject({ path: chapterPath, line: 7 });
	});
	it("indexes included chapter labels and BibTeX definitions with exact source locations", () => {
		const info = {
			rootPath,
			candidates: [rootPath],
			texFiles: [rootPath, chapterPath],
			bibFiles: [bibPath],
			dependencies: [],
		};
		const index = buildTexProjectIndex(
			info,
			new Map([
				[
					rootPath,
					"\\documentclass{article}\n\\begin{document}\n\\section{First}\n\\input{chapters/intro}\n\\bibliography{references}\n\\end{document}",
				],
				[
					chapterPath,
					"\\subsection{Introduction}\n\\label{sec:intro}\nSome text\n\\begin{figure}\n\\caption{Overview}\n\\label{fig:overview}\n\\end{figure}\n\\input{../main}",
				],
				[
					bibPath,
					"% heading\n@article{smith2026,\n title={Research}, author={Smith, Alice}, year={2026}\n}",
				],
			]),
		);
		expect(
			index.labels.map((label) => [label.key, label.path, label.line]),
		).toEqual([
			["sec:intro", chapterPath, 2],
			["fig:overview", chapterPath, 6],
		]);
		expect(
			index.outline
				.filter((item) => item.kind === "section")
				.map((item) => [item.title, item.path]),
		).toEqual([
			["First", rootPath],
			["Introduction", chapterPath],
		]);
		expect(
			index.outline.some(
				(item) => item.kind === "figure" && item.title === "Overview",
			),
		).toBe(true);
		expect(index.outline.length).toBeLessThan(20);
		expect(
			texReferenceDefinition(index, {
				kind: "citation",
				key: "smith2026",
				from: 0,
				to: 0,
			}),
		).toMatchObject({ path: bibPath, line: 2 });
		expect(
			texReferenceDefinition(index, {
				kind: "label",
				key: "sec:intro",
				from: 0,
				to: 0,
			}),
		).toMatchObject({ path: chapterPath, line: 2 });
	});

	it("expands nested inputs relative to the root before the declaring file, matching compilation", () => {
		const localShared = "/vault/thesis/chapters/shared.tex";
		const rootShared = "/vault/thesis/shared.tex";
		const info = {
			rootPath,
			candidates: [rootPath],
			texFiles: [rootPath, chapterPath, rootShared, localShared],
			bibFiles: [],
			dependencies: [],
		};
		const index = buildTexProjectIndex(
			info,
			new Map([
				[rootPath, "\\input{chapters/intro}\n\\input{chapters/shared}"],
				[chapterPath, "\\input{shared}"],
				[rootShared, "\\section{Root shared}"],
				[localShared, "\\section{Local shared}"],
			]),
		);
		expect(
			index.outline
				.filter((item) => item.kind === "section")
				.map((item) => [item.title, item.path]),
		).toEqual([
			["Root shared", rootShared],
			["Local shared", localShared],
		]);
	});

	it("keeps completion replacement inside one citation in a comma separated list", () => {
		const source = "\\citep[see][p. 2]{first,  smith2026, last}";
		const position = source.indexOf("smith2026") + 4;
		const context = texReferenceContext(source, position);
		expect(context).toMatchObject({ kind: "citation", key: "smith2026" });
		expect(source.slice(context?.from, context?.to)).toBe("smith2026");
		expect(texReferenceContext("\\textbf{normal}", 10)).toBeNull();
	});

	it("treats only hyperref's optional target as a label and never treats URLs or link text as references", () => {
		const source =
			"\\begin{document}\n\\href{https://example.com}{External link}\n\\hyperref[sec:target]{Readable link}\n\\end{document}";
		for (const text of ["example.com", "External link", "Readable link"])
			expect(texReferenceContext(source, source.indexOf(text) + 2)).toBeNull();
		expect(
			texReferenceContext(source, source.indexOf("sec:target") + 3),
		).toMatchObject({ kind: "label", key: "sec:target" });
	});

	it("normalizes nested relative project paths on Windows and Unix", () => {
		expect(texPathKey("C:\\vault\\thesis\\chapters\\..\\main.tex")).toBe(
			"C:/vault/thesis/main.tex",
		);
		expect(texPathKey("/vault/thesis/chapters/../main.tex")).toBe(rootPath);
	});

	it("deduplicates catalog entries by normalized DOI and creates a unique citation key", () => {
		const entries = parseBibEntries(
			"@article{smith2026, title={Research}, doi={10.1/abc}}\n@misc{smith20261,title={Other}}",
		);
		expect(
			existingCatalogCitation(entries, {
				doi: "https://doi.org/10.1/ABC",
				title: "New metadata title",
				arxiv_id: null,
			})?.key,
		).toBe("smith2026");
		const entry = catalogBibEntry(
			{
				id: "id",
				bibtex_key: "smith2026",
				title: "A & B {results}",
				authors: ["Alice Smith"],
				year: 2026,
				doi: null,
				arxiv_id: null,
				publication: null,
				volume: null,
				issue: null,
				pages: null,
				publisher: null,
			},
			entries,
		);
		expect(entry.key).toBe("smith20262");
		expect(entry.content).toContain("A \\& B \\{results\\}");
		expect(parseBibEntries(entry.content)).toHaveLength(1);
	});

	it("attaches a missing bibliography without duplicating existing declarations", () => {
		const source =
			"\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}";
		const updated = attachProjectBibliography(source);
		expect(updated).toContain("\\bibliography{references}\n\\end{document}");
		expect(attachProjectBibliography(updated)).toBe(updated);
		const biblatex = attachProjectBibliography(
			"\\usepackage{biblatex}\n\\begin{document}\n\\end{document}",
		);
		expect(biblatex).toContain(
			"\\addbibresource{references.bib}\n\\begin{document}",
		);
		expect(biblatex).toContain("\\printbibliography");
		const commented = attachProjectBibliography(`% \\end{document}\n${source}`);
		expect(commented.startsWith("% \\end{document}\n")).toBe(true);
	});

	it("merges a library paper into the existing bibliography without modifying its root", async () => {
		const bibliography = "@misc{old,title={Previous work}}\n";
		const info = {
			rootPath,
			candidates: [rootPath],
			texFiles: [rootPath],
			bibFiles: [bibPath],
			dependencies: [],
		};
		mocks.load.mockResolvedValue(
			buildTexProjectIndex(
				info,
				new Map([
					[rootPath, "\\bibliography{references}"],
					[bibPath, bibliography],
				]),
			),
		);
		mocks.read.mockResolvedValue(bibliography);
		mocks.persist.mockResolvedValue(true);
		expect(await addCatalogCitation(rootPath, paper)).toBe("smith2026");
		expect(mocks.persist).toHaveBeenCalledOnce();
		expect(mocks.persist).toHaveBeenCalledWith(
			bibPath,
			expect.stringContaining(
				"@misc{old,title={Previous work}}\n\n@misc{smith2026,",
			),
			bibliography,
		);
	});

	it("preserves the body insertion cursor while attaching both biblatex declarations", async () => {
		const source =
			"\\documentclass{article}\n\\usepackage{biblatex}\n\\begin{document}\nBefore target after\n\\end{document}";
		const position = source.indexOf("target");
		const view = new EditorView({
			state: EditorState.create({
				doc: source,
				selection: { anchor: position },
			}),
		});
		const unregister = registerTexEditor(rootPath, view);
		try {
			const info = {
				rootPath,
				candidates: [rootPath],
				texFiles: [rootPath],
				bibFiles: [],
				dependencies: [],
			};
			mocks.load.mockResolvedValue(
				buildTexProjectIndex(info, new Map([[rootPath, source]])),
			);
			mocks.read.mockRejectedValue(new Error("not found"));
			mocks.persist.mockResolvedValue(true);
			const key = await addCatalogCitation(rootPath, paper);
			expect(view.state.selection.main.head).toBe(
				position + "\\addbibresource{references.bib}\n".length,
			);
			insertTexCitation(view, key);
			expect(view.state.doc.toString()).toContain(
				"Before \\cite{smith2026}target after",
			);
			expect(view.state.doc.toString()).toContain(
				"\\addbibresource{references.bib}\n\\begin{document}",
			);
			expect(view.state.doc.toString()).toContain(
				"\\printbibliography\n\\end{document}",
			);
		} finally {
			unregister();
			view.destroy();
		}
	});

	it("creates a declared bibliography target that is missing from the host's existing-file index", async () => {
		const source =
			"\\begin{document}\nBody\n\\bibliography{refs}\n\\end{document}";
		const info = {
			rootPath,
			candidates: [rootPath],
			texFiles: [rootPath],
			bibFiles: [],
			dependencies: [],
		};
		mocks.load.mockResolvedValue(
			buildTexProjectIndex(info, new Map([[rootPath, source]])),
		);
		mocks.read.mockRejectedValue(new Error("not found"));
		mocks.persist.mockResolvedValue(true);
		expect(await addCatalogCitation(rootPath, paper)).toBe("smith2026");
		expect(mocks.persist).toHaveBeenCalledOnce();
		expect(mocks.persist).toHaveBeenCalledWith(
			"/vault/thesis/refs.bib",
			expect.stringContaining("smith2026"),
			"",
		);
	});

	it("reuses a project citation by DOI without writing another entry", async () => {
		const info = {
			rootPath,
			candidates: [rootPath],
			texFiles: [rootPath],
			bibFiles: [bibPath],
			dependencies: [],
		};
		mocks.load.mockResolvedValue(
			buildTexProjectIndex(
				info,
				new Map([
					[bibPath, "@misc{existing,title={Older title},doi={10.1/abc}}"],
				]),
			),
		);
		expect(await addCatalogCitation(rootPath, paper)).toBe("existing");
		expect(mocks.persist).not.toHaveBeenCalled();
	});

	it("refuses bibliography writes when a project buffer cannot be saved", async () => {
		mocks.flush.mockResolvedValue(false);
		await expect(addCatalogCitation(rootPath, paper)).rejects.toThrow();
		expect(mocks.persist).not.toHaveBeenCalled();
	});

	it("extracts inline and display math using the editor grammar", () => {
		const view = new EditorView({
			state: EditorState.create({
				doc: "Text $x^2$ and \\[y=2\\]",
				extensions: [latexLanguage],
			}),
		});
		try {
			expect(texMathAt(view, 7)).toMatchObject({ tex: "x^2", display: false });
			expect(texMathAt(view, 18)).toMatchObject({ tex: "y=2", display: true });
		} finally {
			view.destroy();
		}
	});
});
