import { beforeEach, describe, expect, it } from "vitest";
import { isTexDependencyChange } from "@/lib/tex/auto-build";
import {
	DEFAULT_TEX_SETTINGS,
	explicitTexRoot,
	setTexProjectRoot,
	setTexProjectSettings,
	texBuildOptions,
	texSettingsStore,
	validateTexSettings,
} from "@/lib/tex/config";

beforeEach(() => texSettingsStore.setState({ projects: {}, roots: {} }));

describe("LaTeX project build configuration", () => {
	it("uses incremental builds and keeps force/clean distinct", () => {
		expect(texBuildOptions("/vault/main.tex")).toEqual({
			force: false,
			clean: false,
		});
		expect(texBuildOptions("/vault/main.tex", "force")).toMatchObject({
			force: true,
			clean: false,
		});
		expect(texBuildOptions("/vault/main.tex", "clean")).toMatchObject({
			force: true,
			clean: true,
		});
	});
	it("selects named recipes and returns to the project engine", () => {
		const recipe = {
			name: "Lua",
			tools: [{ command: "latexmk", args: ["-lualatex", "%DOC%"] }],
		};
		setTexProjectSettings("/vault/main.tex", {
			...DEFAULT_TEX_SETTINGS,
			recipes: [recipe],
			selectedRecipe: "Lua",
			outDir: "build",
			jobname: "paper",
		});
		expect(texBuildOptions("/vault/main.tex")).toMatchObject({
			recipe,
			outDir: "build",
			jobname: "paper",
		});
		setTexProjectSettings("/vault/main.tex", {
			...texSettingsStore.getState().projects["/vault/main.tex"],
			selectedRecipe: null,
		});
		expect(texBuildOptions("/vault/main.tex").recipe).toBeUndefined();
	});
	it("rejects malformed commands, duplicate names and invalid build modes", () => {
		for (const value of [
			{ autoBuild: "always" },
			{ recipes: [null] },
			{ recipes: [{ name: "bad", tools: [{ command: "", args: [] }] }] },
			{ recipes: [{ name: "bad", tools: [{ command: "tex", args: [1] }] }] },
			{
				recipes: [
					{ name: "a", tools: [{ command: "tex", args: [] }] },
					{ name: "a", tools: [{ command: "tex", args: [] }] },
				],
			},
		])
			expect(() => validateTexSettings(value)).toThrow();
	});
	it("applies the nearest explicit root to chapters and resets it", () => {
		setTexProjectRoot("C:\\vault\\chapter\\intro.tex", "C:\\vault\\main.tex");
		expect(explicitTexRoot("C:\\vault\\chapter\\intro.tex")).toBe(
			"C:\\vault\\main.tex",
		);
		expect(explicitTexRoot("C:\\vault-other\\intro.tex")).toBeUndefined();
		setTexProjectRoot(
			"C:\\vault\\chapter\\intro.tex",
			"C:\\vault\\chapter\\intro.tex",
		);
		expect(explicitTexRoot("C:\\vault\\chapter\\intro.tex")).toBe(
			"C:\\vault\\chapter\\intro.tex",
		);
		setTexProjectRoot("C:\\vault\\chapter\\intro.tex", "");
		expect(explicitTexRoot("C:\\vault\\chapter\\intro.tex")).toBeUndefined();
	});
	it("replaces a prior standalone override when selecting the parent manuscript", () => {
		setTexProjectRoot("/vault/chapters/intro.tex", "/vault/chapters/intro.tex");
		setTexProjectRoot("/vault/chapters/intro.tex", "/vault/main.tex");
		expect(explicitTexRoot("/vault/chapters/intro.tex")).toBe(
			"/vault/main.tex",
		);
	});
	it("keeps a parent project's choice for siblings of a standalone subfile", () => {
		setTexProjectRoot("/vault/chapters/intro.tex", "/vault/main.tex");
		setTexProjectRoot("/vault/chapters/intro.tex", "/vault/chapters/intro.tex");
		expect(explicitTexRoot("/vault/chapters/intro.tex")).toBe(
			"/vault/chapters/intro.tex",
		);
		expect(explicitTexRoot("/vault/chapters/method.tex")).toBe(
			"/vault/main.tex",
		);
	});
});

it("watches real dependencies, including pictures and bibliography, while ignoring aux writes", () => {
	const deps = [
		"C:\\vault\\main.tex",
		"C:\\vault\\refs.bib",
		"C:\\vault\\plot.pdf",
		"C:\\vault\\main.aux",
	];
	for (const path of [
		"C:/vault/main.tex",
		"C:/vault/refs.bib",
		"C:/vault/plot.pdf",
	])
		expect(isTexDependencyChange(path, deps)).toBe(true);
	for (const path of [
		"C:/vault/main.aux",
		"C:/vault/main.log",
		"C:/other/main.tex",
	])
		expect(isTexDependencyChange(path, deps)).toBe(false);
});
