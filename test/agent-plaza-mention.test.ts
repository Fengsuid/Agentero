import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { filterMentionOptions } from "@/lib/agent/mention";
import {
	arxivRecMentionPath,
	feedMentionPath,
	isPlazaMentionPath,
	lookupPlazaMention,
	PLAZA_ARXIV_REC_COLLECTION_PATH,
	type PlazaMentionEntry,
	parseNeedFulltextIds,
	plazaMentionArxivId,
	plazaMentionPathForArxivId,
	plazaMentionPromptBlock,
	plazaMentionSource,
	registerPlazaMentionEntries,
	splitContextPaths,
} from "@/lib/agent/plaza-mention";
import { assembleTurnPrompt } from "@/lib/agent/turn-prompt";

const t = ((key: string) => key) as unknown as TFunction<"agent", undefined>;

const recEntry: PlazaMentionEntry = {
	path: arxivRecMentionPath("2409.12345"),
	source: "arxiv-rec",
	title: "Scaling Laws for Sparse Towers",
	url: "https://arxiv.org/abs/2409.12345",
	abstract: "We study sparse transformer towers.",
	publishedAt: "2026-09-18",
	sourceLabel: "arXiv Daily",
};

const feedEntry: PlazaMentionEntry = {
	path: feedMentionPath("feed-1"),
	source: "feed",
	title: "Weekly GPU Review",
	url: "https://example.com/gpu",
	abstract: null,
	publishedAt: null,
	sourceLabel: "arXiv cs.LG",
};

describe("plaza mention paths", () => {
	it("builds and classifies virtual paths", () => {
		const rec = arxivRecMentionPath("2409.12345");
		const feed = feedMentionPath("feed-1");
		expect(isPlazaMentionPath(rec)).toBe(true);
		expect(isPlazaMentionPath(feed)).toBe(true);
		expect(isPlazaMentionPath("papers/notes/todo.md")).toBe(false);
		expect(plazaMentionSource(rec)).toBe("arxiv-rec");
		expect(plazaMentionSource(feed)).toBe("feed");
		expect(plazaMentionSource("papers/notes/todo.md")).toBeNull();
	});

	it("registering replaces the whole registry", () => {
		registerPlazaMentionEntries([recEntry, feedEntry]);
		expect(lookupPlazaMention(recEntry.path)?.title).toBe(recEntry.title);
		registerPlazaMentionEntries([feedEntry]);
		expect(lookupPlazaMention(recEntry.path)).toBeNull();
		expect(lookupPlazaMention(feedEntry.path)?.source).toBe("feed");
		registerPlazaMentionEntries([]);
	});

	it("splits composer context paths", () => {
		const { vaultPaths, plazaPaths } = splitContextPaths([
			"papers/a",
			recEntry.path,
			"notes/todo.md",
			feedEntry.path,
		]);
		expect(vaultPaths).toEqual(["papers/a", "notes/todo.md"]);
		expect(plazaPaths).toEqual([recEntry.path, feedEntry.path]);
	});
});

describe("filterMentionOptions with plaza candidates", () => {
	const candidates = ["notes", "papers/a", recEntry.path, feedEntry.path];
	const labels = new Map([
		[recEntry.path, `${recEntry.title} ${recEntry.sourceLabel}`],
		[feedEntry.path, `${feedEntry.title} ${feedEntry.sourceLabel}`],
	]);

	it("hides plaza entries on empty query unless they are recents", () => {
		expect(
			filterMentionOptions({ candidates, query: "", labelsByPath: labels }),
		).not.toContain(recEntry.path);
		const withRecent = filterMentionOptions({
			candidates,
			query: "",
			labelsByPath: labels,
			recent: [feedEntry.path],
		});
		expect(withRecent).toContain(feedEntry.path);
		expect(withRecent).not.toContain(recEntry.path);
	});

	it("surfaces plaza entries on title queries", () => {
		const hit = filterMentionOptions({
			candidates,
			query: "sparse towers",
			labelsByPath: labels,
		});
		expect(hit).toContain(recEntry.path);
		expect(hit).not.toContain(feedEntry.path);
	});

	it("never lists plaza entries inside a folder drill-down", () => {
		const children = filterMentionOptions({
			candidates,
			query: "",
			labelsByPath: labels,
			browseRoot: "papers",
		});
		expect(children).toEqual(["papers/a"]);
	});
});

describe("plaza mention prompt expansion", () => {
	it("expands registered entries and degrades stale ones", () => {
		registerPlazaMentionEntries([recEntry]);
		const block = plazaMentionPromptBlock({
			plazaPaths: [recEntry.path, feedEntry.path],
			t,
		});
		expect(block).toContain("composer.plazaContextInstruction");
		expect(block).toContain(`### ${recEntry.title}`);
		expect(block).toContain(`- Source: ${recEntry.sourceLabel}`);
		expect(block).toContain(`- URL: ${recEntry.url}`);
		expect(block).toContain(recEntry.abstract ?? "");
		expect(block).toContain(`### ${feedEntry.path}`);
		expect(block).toContain("composer.plazaEntryUnavailable");
		registerPlazaMentionEntries([]);
	});

	it("returns an empty block for no plaza paths", () => {
		expect(plazaMentionPromptBlock({ plazaPaths: [], t })).toBe("");
	});

	it("appends scratch full-text paths with the no-import instruction", () => {
		registerPlazaMentionEntries([recEntry, feedEntry]);
		const scratch = new Map([
			[recEntry.path, "/cache/agentero/plaza-scratch/2409.12345/PAPER.md"],
		]);
		const block = plazaMentionPromptBlock({
			plazaPaths: [recEntry.path, feedEntry.path],
			scratchByPath: scratch,
			t,
		});
		expect(block).toContain(
			`- Full text (scratch copy outside the vault, read-only): ${scratch.get(recEntry.path)}`,
		);
		expect(block).toContain("composer.plazaScratchInstruction");
		registerPlazaMentionEntries([]);
	});

	it("omits the scratch instruction when no full text is attached", () => {
		registerPlazaMentionEntries([recEntry]);
		const block = plazaMentionPromptBlock({
			plazaPaths: [recEntry.path],
			t,
		});
		expect(block).not.toContain("Full text (scratch copy");
		expect(block).not.toContain("composer.plazaScratchInstruction");
		registerPlazaMentionEntries([]);
	});
});

describe("plaza mention arxiv ids", () => {
	it("reads the id from a rec path and from feed entry urls", () => {
		registerPlazaMentionEntries([
			recEntry,
			{
				...feedEntry,
				url: "https://arxiv.org/abs/2501.00003",
			},
		]);
		expect(plazaMentionArxivId(recEntry.path)).toBe("2409.12345");
		expect(plazaMentionArxivId(feedEntry.path)).toBe("2501.00003");
		registerPlazaMentionEntries([]);
	});

	it("strips version suffixes so rec and feed refs share one cache id", () => {
		registerPlazaMentionEntries([
			{ ...recEntry, path: arxivRecMentionPath("2409.12345v1") },
			{
				...feedEntry,
				url: "https://arxiv.org/pdf/2409.12345v2",
			},
		]);
		expect(plazaMentionArxivId(arxivRecMentionPath("2409.12345v1"))).toBe(
			"2409.12345",
		);
		expect(plazaMentionArxivId(feedEntry.path)).toBe("2409.12345");
		registerPlazaMentionEntries([]);
	});

	it("returns null for non-arxiv urls and vault paths", () => {
		registerPlazaMentionEntries([
			{ ...feedEntry, url: "https://blog.example.com/posts/gpu" },
		]);
		expect(plazaMentionArxivId(feedEntry.path)).toBeNull();
		expect(plazaMentionArxivId("papers/a")).toBeNull();
		registerPlazaMentionEntries([]);
	});
});

describe("assembleTurnPrompt with plaza mentions", () => {
	it("keeps the plaza block and leaves vault paths to the context resolver", () => {
		registerPlazaMentionEntries([recEntry]);
		const { prompt } = assembleTurnPrompt({
			text: "compare these",
			contextPaths: ["papers/a", recEntry.path],
			visualDrafts: [],
			attachedImages: [],
			isAcpCommand: false,
			t,
		});
		expect(prompt).toContain("compare these");
		expect(prompt).not.toContain("- papers/a");
		expect(prompt).not.toContain("composer.contextInstruction");
		expect(prompt).not.toContain(`- ${recEntry.path}`);
		expect(prompt).toContain(`### ${recEntry.title}`);
		registerPlazaMentionEntries([]);
	});

	it("omits the vault instruction when only plaza paths are attached", () => {
		registerPlazaMentionEntries([recEntry]);
		const { prompt } = assembleTurnPrompt({
			text: "summarize",
			contextPaths: [recEntry.path],
			visualDrafts: [],
			attachedImages: [],
			isAcpCommand: false,
			t,
		});
		expect(prompt).not.toContain("composer.contextInstruction");
		expect(prompt).toContain(`### ${recEntry.title}`);
		registerPlazaMentionEntries([]);
	});

	it("threads scratch full-text paths into the final prompt", () => {
		registerPlazaMentionEntries([recEntry]);
		const markdownPath = "/cache/agentero/plaza-scratch/2409.12345/PAPER.md";
		const { prompt } = assembleTurnPrompt({
			text: "summarize",
			contextPaths: [recEntry.path],
			visualDrafts: [],
			attachedImages: [],
			isAcpCommand: false,
			plazaScratchByPath: new Map([[recEntry.path, markdownPath]]),
			t,
		});
		expect(prompt).toContain(`read-only): ${markdownPath}`);
		expect(prompt).toContain("composer.plazaScratchInstruction");
		registerPlazaMentionEntries([]);
	});
});

describe("arXiv Daily collection mention", () => {
	const collectionEntry: PlazaMentionEntry = {
		path: PLAZA_ARXIV_REC_COLLECTION_PATH,
		source: "arxiv-rec",
		title: "今日推荐（2 篇）",
		url: null,
		abstract: null,
		publishedAt: null,
		sourceLabel: "arXiv Daily",
	};
	const rec2: PlazaMentionEntry = {
		...recEntry,
		path: arxivRecMentionPath("2409.54321v1"),
		title: "GPU Kernel Fusion Limits",
	};

	it("expands to a numbered catalog with the orchestration instruction", () => {
		registerPlazaMentionEntries([collectionEntry, recEntry, rec2]);
		const block = plazaMentionPromptBlock({
			plazaPaths: [PLAZA_ARXIV_REC_COLLECTION_PATH],
			t,
		});
		expect(block).toContain(`### ${collectionEntry.title}`);
		expect(block).toContain(`[1] 2409.12345 · ${recEntry.title}`);
		expect(block).toContain(`[2] 2409.54321 · ${rec2.title}`);
		expect(block).toContain(recEntry.abstract ?? "");
		expect(block).toContain("composer.plazaCollectionInstruction");
		// No per-entry metadata block for the collection path itself.
		expect(block).not.toContain("- Source: arXiv Daily");
		registerPlazaMentionEntries([]);
	});

	it("degrades to the unavailable note when the collection is unregistered", () => {
		registerPlazaMentionEntries([recEntry]);
		const block = plazaMentionPromptBlock({
			plazaPaths: [PLAZA_ARXIV_REC_COLLECTION_PATH],
			t,
		});
		expect(block).toContain("composer.plazaEntryUnavailable");
		registerPlazaMentionEntries([]);
	});

	it("resolves mention paths for NEED_FULLTEXT ids across sources", () => {
		registerPlazaMentionEntries([
			collectionEntry,
			rec2,
			{ ...feedEntry, url: "https://arxiv.org/abs/2501.00003" },
		]);
		expect(plazaMentionPathForArxivId("2409.54321v2")).toBe(rec2.path);
		expect(plazaMentionPathForArxivId("2501.00003")).toBe(feedEntry.path);
		expect(plazaMentionPathForArxivId("1907.00000")).toBeNull();
		registerPlazaMentionEntries([]);
	});

	it("keeps the pinned collection visible at an empty query", () => {
		const options = {
			candidates: ["notes", recEntry.path, PLAZA_ARXIV_REC_COLLECTION_PATH],
			query: "",
			labelsByPath: new Map(),
			pinned: [PLAZA_ARXIV_REC_COLLECTION_PATH],
		};
		const visible = filterMentionOptions(options);
		expect(visible).toContain(PLAZA_ARXIV_REC_COLLECTION_PATH);
		expect(visible).not.toContain(recEntry.path);
	});
});

describe("parseNeedFulltextIds", () => {
	it("parses ids from the first line, dedupes and caps at 3", () => {
		expect(
			parseNeedFulltextIds(
				"NEED_FULLTEXT 2409.12345 2409.54321v2 2409.12345 2607.23250 2609.20723",
			),
		).toEqual(["2409.12345", "2409.54321", "2607.23250"]);
	});

	it("ignores markers that are not the first non-empty line", () => {
		expect(
			parseNeedFulltextIds("分析如下……\nNEED_FULLTEXT 2409.12345"),
		).toBeNull();
	});

	it("rejects lines without valid ids and plain text", () => {
		expect(parseNeedFulltextIds("NEED_FULLTEXT")).toBeNull();
		expect(parseNeedFulltextIds("NEED_FULLTEXT some-words")).toBeNull();
		expect(parseNeedFulltextIds("以下是最终报告。")).toBeNull();
	});
});
