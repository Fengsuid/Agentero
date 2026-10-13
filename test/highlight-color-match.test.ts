import { PdfAnnotationSubtype } from "@embedpdf/models";
import { describe, expect, it } from "vitest";
import { highlightColorFromItems } from "@/lib/pdf/annotation-ref";

function highlight(
	id: string,
	quote: string,
	color: string,
	pageIndex: number,
) {
	return {
		annotation: {
			id,
			type: PdfAnnotationSubtype.HIGHLIGHT,
			pageIndex,
			contents: "",
			strokeColor: "#fcd34d",
			rect: { origin: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
			custom: { paletteKey: color, quote },
		},
	};
}

describe("highlightColorFromItems", () => {
	const items = [
		highlight("note-a", "RQ2: Are models strong?", "blue", 5),
		highlight("note-b", "Another sentence.", "pink", 2),
	];

	it("prefers the saved annotation id", () => {
		expect(
			highlightColorFromItems(items, {
				id: "note-b",
				quote: "RQ2: Are models strong?",
				page: 6,
			}),
		).toBe("pink");
	});

	it("matches the quote on the same page when the id is absent", () => {
		expect(
			highlightColorFromItems(items, {
				quote: "RQ2:  Are models strong?",
				page: 6,
			}),
		).toBe("blue");
		expect(
			highlightColorFromItems(items, {
				quote: "RQ2: Are models strong?",
				page: 3,
			}),
		).toBeNull();
	});
});
