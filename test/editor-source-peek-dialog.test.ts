// @vitest-environment happy-dom

import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownSourcePeekDialog } from "@/components/editor/overlays/source-peek-dialog";

const copyTextToClipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/core/clipboard", () => ({ copyTextToClipboard }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	copyTextToClipboard.mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function renderDialog(source: string) {
	const i18n = createInstance();
	await i18n.init({ lng: "en", resources: {} });
	await act(async () => {
		root.render(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(MarkdownSourcePeekDialog, {
					open: true,
					source,
					onClose: () => {},
				}),
			),
		);
	});
}

describe("Markdown source peek dialog", () => {
	it("shows the captured source read-only and copies all of it", async () => {
		const source = "---\ntitle: A note\n---\n\n# Heading\n\nBody $x$.\n";
		await renderDialog(source);

		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		expect(textarea?.value).toBe(source);
		expect(textarea?.readOnly).toBe(true);

		const copyButton = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === "sourcePeek.copy",
		);
		expect(copyButton).toBeTruthy();
		await act(async () => copyButton?.click());

		expect(copyTextToClipboard).toHaveBeenCalledWith(
			source,
			expect.objectContaining({ successMessage: "sourcePeek.copied" }),
		);
	});
});
