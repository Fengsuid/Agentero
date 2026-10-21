// @vitest-environment happy-dom

import { BoldPlugin } from "@platejs/basic-nodes/react";
import { ListPlugin } from "@platejs/list/react";
import { createInstance } from "i18next";
import type { Range } from "platejs";
import { createPlateEditor, ParagraphPlugin, Plate } from "platejs/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditorToolbar } from "@/components/editor/toolbar/markdown-toolbar";
import { TooltipProvider } from "@/components/ui/tooltip";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function renderToolbar(selection: Range | null) {
	const editor = createPlateEditor({
		plugins: [ParagraphPlugin, BoldPlugin, ListPlugin],
		value: [{ type: "p", children: [{ text: "bold", bold: true }] }],
	});
	editor.selection = selection;
	const i18n = createInstance();
	await i18n.init({ lng: "en", resources: {} });
	await act(async () => {
		root.render(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(
					TooltipProvider,
					null,
					createElement(
						Plate,
						{ editor },
						createElement(MarkdownEditorToolbar, {}),
					),
				),
			),
		);
	});
	return container.querySelector<HTMLButtonElement>(
		'button[aria-label="toolbar.bold"]',
	);
}

describe("Markdown toolbar selection boundary", () => {
	it.each([
		null,
		{ anchor: { path: [0], offset: 0 }, focus: { path: [0], offset: 0 } },
		{ anchor: { path: [3, 0], offset: 0 }, focus: { path: [3, 0], offset: 0 } },
		{ anchor: { path: [0, 0], offset: 8 }, focus: { path: [0, 0], offset: 8 } },
	])("renders disabled mark actions for transient selection %j", async (selection) => {
		const bold = await renderToolbar(selection);
		expect(bold).not.toBeNull();
		expect(bold?.disabled).toBe(true);
	});

	it("reads real text marks once a text selection is available", async () => {
		const bold = await renderToolbar({
			anchor: { path: [0, 0], offset: 2 },
			focus: { path: [0, 0], offset: 2 },
		});
		expect(bold?.disabled).toBe(false);
		expect(bold?.getAttribute("data-state")).toBe("on");
	});
});
