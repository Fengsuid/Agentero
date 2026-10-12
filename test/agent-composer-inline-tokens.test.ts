import { describe, expect, it } from "vitest";
import {
	appendMissingInlineTokens,
	appendSelectionTokens,
	encodeCommandToken,
	encodeMentionToken,
	encodeSelectionToken,
	encodeSkillToken,
	extractMentionPaths,
	extractSelectionTokens,
	extractSkillIds,
	parseInlineTokenParts,
	plainTriggerSuffix,
	replaceTrailingTriggerWithToken,
	stripInlineTokens,
} from "@/lib/agent/composer-inline-tokens";
import type { SelectionContext } from "@/lib/agent/selection-store";

describe("composer inline tokens", () => {
	it("round-trips mention and skill markers", () => {
		const path = "papers/foo/NOTES.md";
		const skill = "paper-reader";
		const text = `see ${encodeMentionToken(path)} and ${encodeSkillToken(skill)} please`;
		expect(extractMentionPaths(text)).toEqual([path]);
		expect(extractSkillIds(text)).toEqual([skill]);
		expect(stripInlineTokens(text)).toBe("see and please");
	});

	it("expands command markers to /name on send", () => {
		const text = `run ${encodeCommandToken("summarize")} now`;
		expect(stripInlineTokens(text)).toBe("run /summarize now");
	});

	it("encodes odd path characters", () => {
		const path = "notes/a b/文件.md";
		const token = encodeMentionToken(path);
		expect(extractMentionPaths(`x ${token} y`)).toEqual([path]);
	});

	it("replaces a trailing @ trigger with a mention token", () => {
		const next = replaceTrailingTriggerWithToken(
			"hello @no",
			"mention",
			encodeMentionToken("a.md"),
		);
		expect(next).toBe(`hello ${encodeMentionToken("a.md")} `);
		expect(extractMentionPaths(next)).toEqual(["a.md"]);
	});

	it("replaces a trailing $ trigger with a skill token", () => {
		const next = replaceTrailingTriggerWithToken(
			"run $pap",
			"skill",
			encodeSkillToken("paper-reader"),
		);
		expect(next).toBe(`run ${encodeSkillToken("paper-reader")} `);
	});

	it("replaces a trailing / trigger with a command token", () => {
		const next = replaceTrailingTriggerWithToken(
			"do /sum",
			"command",
			encodeCommandToken("summarize"),
		);
		expect(next).toBe(`do ${encodeCommandToken("summarize")} `);
		expect(stripInlineTokens(next)).toBe("do /summarize");
	});

	it("appends missing tokens for legacy drafts", () => {
		const next = appendMissingInlineTokens(
			"hello",
			["a.md", "b.md"],
			["skill-a"],
		);
		expect(extractMentionPaths(next)).toEqual(["a.md", "b.md"]);
		expect(extractSkillIds(next)).toEqual(["skill-a"]);
		expect(next.startsWith("hello")).toBe(true);
	});

	it("does not duplicate tokens already present", () => {
		const token = encodeMentionToken("a.md");
		const next = appendMissingInlineTokens(`x ${token} `, ["a.md"], []);
		expect(next).toBe(`x ${token} `);
	});

	it("masks markers in the trigger suffix so $ inside tokens is inert", () => {
		const text = `x ${encodeSkillToken("ab")} $c`;
		expect(plainTriggerSuffix(text).endsWith(" $c")).toBe(true);
		expect(plainTriggerSuffix(text)).not.toContain("{{");
	});

	it("parses parts for rendering", () => {
		const parts = parseInlineTokenParts(
			`A ${encodeMentionToken("p.md")} B ${encodeSkillToken("s1")} C ${encodeCommandToken("cmd")}`,
		);
		expect(parts).toEqual([
			{ type: "text", value: "A " },
			{ type: "mention", path: "p.md" },
			{ type: "text", value: " B " },
			{ type: "skill", skillId: "s1" },
			{ type: "text", value: " C " },
			{ type: "command", name: "cmd" },
		]);
	});

	describe("selection tokens", () => {
		const selection: SelectionContext = {
			id: "sel-1",
			text: "attention is all you need",
			sourcePath: "papers/transformer",
			origin: "pdf",
			page: 3,
			pinned: false,
		};

		it("round-trips selection markers", () => {
			const token = encodeSelectionToken(selection);
			const text = `see ${token} please`;
			expect(extractSelectionTokens(text)).toEqual([selection]);
			expect(stripInlineTokens(text)).toBe("see please");
		});

		it("preserves PDF anchor geometry", () => {
			const withGeometry: SelectionContext = {
				...selection,
				rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
				paperAbsPath: "/vault/papers/transformer",
			};
			const token = encodeSelectionToken(withGeometry);
			const recovered = extractSelectionTokens(token);
			expect(recovered).toEqual([withGeometry]);
		});

		it("round-trips selection text with Unicode characters", () => {
			const unicode: SelectionContext = {
				...selection,
				text: "注意力机制 你好 🌍",
				sourcePath: "papers/注意力机制",
			};
			const token = encodeSelectionToken(unicode);
			const recovered = extractSelectionTokens(`x ${token} y`);
			expect(recovered).toEqual([unicode]);
		});

		it("parses selection parts for rendering", () => {
			const token = encodeSelectionToken(selection);
			const parts = parseInlineTokenParts(`A ${token} B`);
			expect(parts).toEqual([
				{ type: "text", value: "A " },
				{ type: "selection", selection },
				{ type: "text", value: " B" },
			]);
		});

		it("masks selection markers in trigger suffix", () => {
			const text = `x ${encodeSelectionToken(selection)} $c`;
			expect(plainTriggerSuffix(text).endsWith(" $c")).toBe(true);
			expect(plainTriggerSuffix(text)).not.toContain("{{");
		});

		it("treats a selection token as a trigger boundary", () => {
			const text = `${encodeSelectionToken(selection)}@notes`;
			expect(plainTriggerSuffix(text)).toMatch(/(^|\s|\uFFFC)@([^\s]*)$/);
		});

		it("appends new quotes after prose and leaves earlier quotes in place", () => {
			const first = {
				...selection,
				id: "one",
				text: "first block",
			};
			const second = {
				...selection,
				id: "two",
				text: "second block",
			};
			const draft = `对于 ${encodeSelectionToken(first)} 以及`;
			const next = appendSelectionTokens(draft, [first, second]);
			expect(extractSelectionTokens(next).map((item) => item.id)).toEqual([
				"one",
				"two",
			]);
			expect(next.startsWith("对于 ")).toBe(true);
			expect(next.includes(" 以及 ")).toBe(true);
			expect(appendSelectionTokens("", [second])).toBe(
				encodeSelectionToken(second),
			);
			expect(appendSelectionTokens("对于 ", [second]).startsWith("对于 ")).toBe(
				true,
			);
		});

		it("replaces a trigger that sits against a selection token", () => {
			const token = encodeSelectionToken(selection);
			const next = replaceTrailingTriggerWithToken(
				`${token}@notes`,
				"mention",
				encodeMentionToken("notes/a.md"),
			);
			expect(next.startsWith(token)).toBe(true);
			expect(next).not.toContain("@notes");
			expect(extractMentionPaths(next)).toEqual(["notes/a.md"]);
		});
	});
});
