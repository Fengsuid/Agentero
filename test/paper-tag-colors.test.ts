import { describe, expect, it } from "vitest";
import { withPaperTagColor } from "@/lib/paper/tags";

describe("paper tag colors", () => {
	it("edits an existing tag without losing hidden provenance, names, or other colors", () => {
		const tags = [
			{ name: "@zotero:source" },
			{ name: "@arxiv:cs.AI" },
			{ name: "Topic", color: "blue" },
			{ name: "Other", color: "green" },
		];
		const changed = withPaperTagColor(tags, "topic", "red");
		expect(changed).toEqual([
			tags[0],
			tags[1],
			{ name: "Topic", color: "red" },
			tags[3],
		]);
		expect(withPaperTagColor(changed, "Topic", null)[2]).toEqual({
			name: "Topic",
		});
		expect(tags[2].color).toBe("blue");
	});
});
