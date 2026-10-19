import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { ByteIndex } from "@/lib/tex-live/byte-index";

describe("tex-live ByteIndex", () => {
	it("maps UTF-16 positions to UTF-8 bytes on mixed text", () => {
		const doc = Text.of(["你好 world", "abc"]);
		const index = new ByteIndex(doc);
		expect(index.byteAt(doc, 0)).toBe(0);
		expect(index.byteAt(doc, 1)).toBe(3); // after 你
		expect(index.byteAt(doc, 2)).toBe(6); // after 你好
		expect(index.byteAt(doc, doc.line(2).from)).toBe(13); // 6 + space + "world" + \n
	});

	it("rebuilds line starts after an edit", () => {
		const before = Text.of(["abc", "def"]);
		const index = new ByteIndex(before);
		const after = Text.of(["abc你", "def"]);
		index.update(after, 1);
		expect(index.byteAt(after, after.line(2).from)).toBe(7);
	});

	it("rebuilds when a different document is passed", () => {
		const first = Text.of(["aa"]);
		const index = new ByteIndex(first);
		const second = Text.of(["aa", "bb"]);
		expect(index.byteAt(second, second.line(2).from)).toBe(3);
	});
});
