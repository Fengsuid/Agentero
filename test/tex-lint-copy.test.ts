// @vitest-environment happy-dom
import "@/i18n";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TextEditorLintFooter } from "@/components/viewer/text-editor-lint-footer";

const copy = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/core/clipboard", () => ({ copyTextToClipboard: copy }));

it("keeps navigation, per-problem copy, and text selection independent", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const onJump = vi.fn();
	const diagnostics = [
		{
			from: 0,
			to: 1,
			line: 44,
			column: 1,
			severity: "warning" as const,
			message: "Command terminated with space. (chktex 1)",
		},
		{
			from: 2,
			to: 3,
			line: 46,
			column: 1,
			severity: "warning" as const,
			message: "Command terminated with space. (chktex 1)",
		},
	];
	try {
		await act(async () =>
			root.render(
				createElement(TextEditorLintFooter, {
					path: "/vault/main.tex",
					diagnostics,
					onJump,
				}),
			),
		);
		const jump = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.includes(diagnostics[0].message),
		);
		expect(jump).toBeDefined();
		await act(async () => jump?.click());
		expect(onJump).toHaveBeenCalledWith(diagnostics[0]);
		expect(copy).not.toHaveBeenCalled();
		const copyButtons = host.querySelectorAll<HTMLButtonElement>(
			'[aria-label="Copy problem"]',
		);
		expect(copyButtons).toHaveLength(2);
		expect(host.textContent).not.toContain("Copy all problems");
		onJump.mockClear();
		await act(async () => copyButtons[0].click());
		expect(copy).toHaveBeenLastCalledWith(
			"/vault/main.tex:44:1 [warning]\nCommand terminated with space. (chktex 1)",
			expect.any(Object),
		);
		expect(onJump).not.toHaveBeenCalled();
		const message = jump?.querySelector("span");
		expect(jump?.className).toContain("select-text");
		expect(message).toBeTruthy();
		const range = document.createRange();
		if (message) range.selectNodeContents(message);
		window.getSelection()?.addRange(range);
		await act(async () => {
			jump?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, detail: 1 }),
			);
		});
		expect(onJump).not.toHaveBeenCalled();
		window.getSelection()?.removeAllRanges();
		await act(async () => {
			jump?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, detail: 1 }),
			);
		});
		expect(onJump).toHaveBeenCalledWith(diagnostics[0]);
		expect(copy).toHaveBeenCalledTimes(1);
	} finally {
		window.getSelection()?.removeAllRanges();
		await act(async () => root.unmount());
		host.remove();
	}
});
