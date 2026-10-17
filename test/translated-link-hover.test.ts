import type { PdfLinkAnnoObject, PdfLinkTarget } from "@embedpdf/models";
import { PdfActionType } from "@embedpdf/models";
import { describe, expect, it } from "vitest";
import { translatedLinkHoverAction } from "@/lib/pdf/layout/translated-link-hover";
import type { PreservedLinkAssignment } from "@/lib/pdf/layout/translated-links";

function assignment(
	partial: Partial<PreservedLinkAssignment> = {},
): PreservedLinkAssignment {
	return {
		start: 0,
		end: 4,
		text: "[12]",
		key: "link-1",
		...partial,
	};
}

function link(target: PdfLinkTarget | undefined): PdfLinkAnnoObject {
	return { id: "link-1", target } as PdfLinkAnnoObject;
}

describe("translatedLinkHoverAction", () => {
	it("clears when the pointer leaves the token", () => {
		expect(translatedLinkHoverAction(null, undefined)).toEqual({
			kind: "clear",
		});
	});

	it("opens the citation card for an in-document link", () => {
		const goto = link({
			type: "action",
			action: {
				type: PdfActionType.Goto,
				destination: {
					pageIndex: 3,
					zoom: { mode: 1, params: { x: 0, y: 400, zoom: 0 } },
					view: [],
				},
			},
		} as PdfLinkTarget);
		expect(translatedLinkHoverAction(assignment(), goto)).toEqual({
			kind: "citation",
			link: goto,
		});
	});

	it("opens the URL tip for an annotation URI", () => {
		const uri = link({
			type: "action",
			action: { type: PdfActionType.URI, uri: "  https://example.com/paper  " },
		});
		expect(translatedLinkHoverAction(assignment(), uri)).toEqual({
			kind: "url",
			url: "https://example.com/paper",
		});
	});

	it("opens the URL tip for a launch path", () => {
		const launch = link({
			type: "action",
			action: {
				type: PdfActionType.LaunchAppOrOpenFile,
				path: "papers/a.pdf",
			},
		});
		expect(
			translatedLinkHoverAction(assignment({ url: undefined }), launch),
		).toEqual({ kind: "url", url: "papers/a.pdf" });
	});

	it("opens the URL tip for a text URL that has no annotation", () => {
		expect(
			translatedLinkHoverAction(
				assignment({
					key: null,
					url: " https://arxiv.org/abs/1 ",
					text: "url",
				}),
				undefined,
			),
		).toEqual({ kind: "url", url: "https://arxiv.org/abs/1" });
	});

	it("clears when the token is not a link", () => {
		expect(
			translatedLinkHoverAction(
				assignment({ key: null, url: "  " }),
				undefined,
			),
		).toEqual({ kind: "clear" });
	});
});
