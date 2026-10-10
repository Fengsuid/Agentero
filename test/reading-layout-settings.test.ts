import { describe, expect, it } from "vitest";
import {
	clampMarkdownMaxWidth,
	clampWikiEmbedFontSize,
	DEFAULT_MARKDOWN_MAX_WIDTH,
	DEFAULT_WIKI_EMBED_FONT_SIZE,
} from "@/lib/settings/defaults";

describe("reading layout settings", () => {
	it("clamps wiki embed font size onto 12–20", () => {
		expect(clampWikiEmbedFontSize(Number.NaN)).toBe(
			DEFAULT_WIKI_EMBED_FONT_SIZE,
		);
		expect(clampWikiEmbedFontSize(8)).toBe(12);
		expect(clampWikiEmbedFontSize(13.4)).toBe(13);
		expect(clampWikiEmbedFontSize(20)).toBe(20);
		expect(clampWikiEmbedFontSize(32)).toBe(20);
	});

	it("keeps markdown max width on the preset list", () => {
		expect(clampMarkdownMaxWidth(0)).toBe(DEFAULT_MARKDOWN_MAX_WIDTH);
		expect(clampMarkdownMaxWidth(-1)).toBe(0);
		expect(clampMarkdownMaxWidth(500)).toBe(0);
		expect(clampMarkdownMaxWidth(800)).toBe(800);
		expect(clampMarkdownMaxWidth(1120.2)).toBe(1120);
	});
});
