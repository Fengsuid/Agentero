import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	inspect: vi.fn(),
	handlers: [] as ((event: { paths: string[] }) => void)[],
	unlisten: vi.fn(),
}));
vi.mock("@/lib/tex/host", () => ({ inspectLatexProject: mocks.inspect }));
vi.mock("@/lib/workspace/tex-compile", () => ({
	resolveTexRoot: vi.fn().mockResolvedValue("/vault/main.tex"),
}));
vi.mock("@/lib/vault/fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/vault/fs")>()),
	readVaultFile: mocks.read,
}));
vi.mock("@/lib/core/tauri-events", () => ({
	listenEventSafe: vi.fn((_binding, handler) => {
		mocks.handlers.push(handler);
		return mocks.unlisten;
	}),
}));

import {
	invalidateTexProjectIndex,
	loadTexProjectIndex,
	notifyTexProjectFilesChanged,
	registerTexProjectBuffer,
	subscribeTexProjectChanges,
} from "@/lib/tex/project-index";

const rootPath = "/vault/main.tex";
const chapter = "/vault/chapter.tex";
const bib = "/vault/refs.bib";
let cleanup: (() => void)[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.handlers.length = 0;
	invalidateTexProjectIndex();
});
afterEach(() => {
	for (const dispose of cleanup) dispose();
	cleanup = [];
});

describe("LaTeX project graph refresh", () => {
	it("discovers a new include after persistence even when the first outline ran before autosave", async () => {
		let diskRoot = "\\begin{document}\n\\end{document}";
		const liveRoot = "\\begin{document}\n\\input{chapter}\n\\end{document}";
		mocks.inspect.mockImplementation(async () => ({
			rootPath,
			candidates: [rootPath],
			texFiles: diskRoot.includes("\\input") ? [rootPath, chapter] : [rootPath],
			bibFiles: [],
			dependencies: [],
		}));
		mocks.read.mockImplementation(async (path: string) =>
			path === chapter ? "\\section{New chapter}\n\\label{new}" : diskRoot,
		);
		cleanup.push(registerTexProjectBuffer(rootPath, () => liveRoot));
		expect(
			(await loadTexProjectIndex(rootPath)).outline.some(
				(item) => item.title === "New chapter",
			),
		).toBe(false);
		let refreshed: ReturnType<typeof loadTexProjectIndex> | undefined;
		cleanup.push(
			subscribeTexProjectChanges(() => {
				refreshed = loadTexProjectIndex(rootPath);
			}),
		);
		diskRoot = liveRoot;
		notifyTexProjectFilesChanged([rootPath]);
		expect(
			(await refreshed)?.outline.some((item) => item.title === "New chapter"),
		).toBe(true);
		expect(mocks.inspect).toHaveBeenCalledTimes(2);
	});

	it("invalidates cached citation data immediately on an external bibliography watcher event", async () => {
		let bibliography = "@article{old,title={Before}}";
		mocks.inspect.mockResolvedValue({
			rootPath,
			candidates: [rootPath],
			texFiles: [rootPath],
			bibFiles: [bib],
			dependencies: [],
		});
		mocks.read.mockImplementation(async (path: string) =>
			path === bib
				? bibliography
				: "\\begin{document}\n\\bibliography{refs}\n\\end{document}",
		);
		expect(
			(await loadTexProjectIndex(rootPath)).citations.map((entry) => entry.key),
		).toEqual(["old"]);
		const subscriber = vi.fn();
		cleanup.push(subscribeTexProjectChanges(subscriber));
		bibliography = "@article{new,title={After}}";
		mocks.handlers[0]({ paths: [bib] });
		expect(subscriber).toHaveBeenCalledWith([bib]);
		expect(
			(await loadTexProjectIndex(rootPath)).citations.map((entry) => entry.key),
		).toEqual(["new"]);
	});
});
