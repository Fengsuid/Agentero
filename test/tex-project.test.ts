import { describe, expect, it } from "vitest";
import {
	isInsideProject,
	reduceTexProject,
	siblingTexPath,
	type TexProject,
} from "@/lib/tex/project";

const thesis: TexProject = {
	texPath: "/vault/thesis/chapters/intro.tex",
	rootDir: "/vault/thesis",
};

describe("tex project root directory", () => {
	it("treats the root file's directory as the project, including nested files", () => {
		expect(
			isInsideProject("/vault/thesis/chapters/intro.tex", "/vault/thesis"),
		).toBe(true);
		expect(
			isInsideProject("/vault/thesis/figures/plot.pdf", "/vault/thesis"),
		).toBe(true);
		expect(isInsideProject("/vault/notes/foo.md", "/vault/thesis")).toBe(false);
		expect(isInsideProject("/vault/thesis-notes/foo.md", "/vault/thesis")).toBe(
			false,
		);
	});

	it("maps a same-stem pdf or log onto the tex source", () => {
		expect(siblingTexPath("/vault/thesis/main.pdf")).toBe(
			"/vault/thesis/main.tex",
		);
		expect(siblingTexPath("C:\\vault\\thesis\\main.LOG")).toBe(
			"C:\\vault\\thesis\\main.tex",
		);
		expect(siblingTexPath("/vault/thesis/chapters/intro.tex")).toBe(null);
		expect(siblingTexPath("/vault/thesis/figures/plot.png")).toBe(null);
	});

	it("follows the resolved root when the active file is tex", () => {
		expect(
			reduceTexProject(
				null,
				"/vault/thesis/chapters/intro.tex",
				"/vault/thesis/main.tex",
				"/vault/thesis/chapters/intro.tex",
			),
		).toEqual(thesis);
	});

	it("keeps the tex being edited while a file in the same root directory is open", () => {
		expect(
			reduceTexProject(
				thesis,
				"/vault/thesis/main.pdf",
				"/vault/thesis/main.tex",
				"/vault/thesis/main.tex",
			),
		).toEqual(thesis);
		expect(
			reduceTexProject(thesis, "/vault/thesis/figures/plot.png", null, null),
		).toEqual(thesis);
	});

	it("opens a pdf onto its sibling tex when no project is current", () => {
		expect(
			reduceTexProject(
				null,
				"/vault/thesis/main.pdf",
				"/vault/thesis/main.tex",
				"/vault/thesis/main.tex",
			),
		).toEqual({
			texPath: "/vault/thesis/main.tex",
			rootDir: "/vault/thesis",
		});
	});

	it("drops the project outside the root directory and switches when the root changes", () => {
		expect(
			reduceTexProject(thesis, "/vault/notes/foo.md", null, null),
		).toBeNull();
		expect(
			reduceTexProject(
				thesis,
				"/vault/other/note.tex",
				"/vault/other/note.tex",
				"/vault/other/note.tex",
			),
		).toEqual({
			texPath: "/vault/other/note.tex",
			rootDir: "/vault/other",
		});
	});
});
