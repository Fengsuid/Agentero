import { describe, expect, it } from "vitest";
import { chooseTexEngine, parseTexProgram } from "@/lib/tex/engine";

const ALL = ["pdflatex", "xelatex", "lualatex"];

describe("parseTexProgram", () => {
	it("reads program and TS-program magic comments", () => {
		expect(
			parseTexProgram("% !TEX program = xelatex\n\\documentclass{ctex}"),
		).toBe("xelatex");
		expect(parseTexProgram("%!TeX TS-program = lualatex")).toBe("lualatex");
		expect(parseTexProgram("% !TEX program = PDFLaTeX")).toBe("pdflatex");
	});

	it("ignores non-engine programs and commented-out lines that are not directives", () => {
		expect(parseTexProgram("% !TEX program = latexmk")).toBeNull();
		expect(parseTexProgram("code % !TEX program = xelatex")).toBeNull();
		expect(parseTexProgram("% !TEX root = main.tex")).toBeNull();
	});
});

describe("chooseTexEngine", () => {
	it("prefers the root file, then the remembered choice, then XeLaTeX", () => {
		expect(
			chooseTexEngine({
				magic: "lualatex",
				remembered: "pdflatex",
				available: ALL,
			}),
		).toBe("lualatex");
		expect(
			chooseTexEngine({
				magic: null,
				remembered: "pdflatex",
				available: ALL,
			}),
		).toBe("pdflatex");
		expect(
			chooseTexEngine({ magic: null, remembered: null, available: ALL }),
		).toBe("xelatex");
	});

	it("skips an engine the machine does not have", () => {
		expect(
			chooseTexEngine({
				magic: "xelatex",
				remembered: null,
				available: ["pdflatex", "lualatex"],
			}),
		).toBe("pdflatex");
		expect(
			chooseTexEngine({
				magic: null,
				remembered: null,
				available: ["pdflatex"],
			}),
		).toBe("pdflatex");
		expect(
			chooseTexEngine({ magic: null, remembered: null, available: [] }),
		).toBeNull();
	});
});
