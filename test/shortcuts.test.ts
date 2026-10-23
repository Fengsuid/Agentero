import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/core/tauri", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/core/tauri")>();
	return {
		...actual,
		getPlatformOS: vi.fn(() => "macos"),
	};
});

import { getPlatformOS } from "@/lib/core/tauri";
import {
	formatShortcut,
	isFindShortcut,
	resolveShortcutId,
	shortcutBelongsToTextField,
} from "@/lib/shell/shortcuts";

function keyEvent(init: {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
}): KeyboardEvent {
	return {
		key: init.key,
		metaKey: init.metaKey ?? false,
		ctrlKey: init.ctrlKey ?? false,
		altKey: init.altKey ?? false,
		shiftKey: init.shiftKey ?? false,
	} as KeyboardEvent;
}

describe("shell shortcuts", () => {
	afterEach(() => {
		vi.mocked(getPlatformOS).mockReturnValue("macos");
	});

	it("resolves Obsidian-style split pane shortcut", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "\\", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBe("splitPane");
		vi.mocked(getPlatformOS).mockReturnValue("windows");
		expect(
			resolveShortcutId(keyEvent({ key: "\\", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBe("splitPane");
	});

	it("distinguishes Ctrl and Meta on macOS", () => {
		vi.mocked(getPlatformOS).mockReturnValue("macos");
		expect(
			resolveShortcutId(keyEvent({ key: "ArrowLeft", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBeNull();
		expect(
			resolveShortcutId(keyEvent({ key: "\\", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBeNull();
		expect(
			resolveShortcutId(keyEvent({ key: "ArrowLeft", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBe("collapseTreeCurrent");
	});

	it("renders the split pane chord", () => {
		expect(formatShortcut({ key: "\\", meta: true })).toContain("\\");
	});

	it("separates reopen tab from the terminal chord", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "t", metaKey: true, shiftKey: true }), {
				settingsOpen: false,
			}),
		).toBe("reopenTab");
		expect(
			resolveShortcutId(keyEvent({ key: "t", metaKey: true, altKey: true }), {
				settingsOpen: false,
			}),
		).toBe("openInTerminal");
	});

	it("binds ⌘K to quick chat and ⇧⌘A to add-to-chat", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "k", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBe("quickChat");
		expect(
			resolveShortcutId(keyEvent({ key: "a", metaKey: true, shiftKey: true }), {
				settingsOpen: false,
			}),
		).toBe("addSelectionToChat");
		expect(
			resolveShortcutId(keyEvent({ key: "a", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBeNull();
	});

	it("leaves ⌘P as quick open", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "p", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBe("quickOpen");
	});

	it("binds ⌘L to toggleChat (add selection when any)", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "l", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBe("toggleChat");
	});

	it("leaves the ⌘B sidebar alias to focused text fields", () => {
		vi.mocked(getPlatformOS).mockReturnValue("windows");
		expect(
			resolveShortcutId(keyEvent({ key: "b", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBe("toggleSidebar");
		const textarea = {
			closest: () => ({}),
		} as unknown as EventTarget;
		expect(
			shortcutBelongsToTextField("toggleSidebar", {
				key: "b",
				target: textarea,
			}),
		).toBe(true);
		expect(
			shortcutBelongsToTextField("toggleSidebar", {
				key: "s",
				target: textarea,
			}),
		).toBe(false);
		expect(
			shortcutBelongsToTextField("toggleSidebar", {
				key: "b",
				target: null,
			}),
		).toBe(false);
	});

	it("binds F11 to borderless fullscreen only on Windows", () => {
		vi.mocked(getPlatformOS).mockReturnValue("windows");
		expect(
			resolveShortcutId(keyEvent({ key: "F11" }), { settingsOpen: false }),
		).toBe("toggleFullscreen");

		vi.mocked(getPlatformOS).mockReturnValue("macos");
		expect(
			resolveShortcutId(keyEvent({ key: "F11" }), { settingsOpen: false }),
		).toBeNull();
	});

	it("keeps macOS native fullscreen out of local find and shell actions", () => {
		const fullscreen = keyEvent({ key: "f", metaKey: true, ctrlKey: true });
		expect(isFindShortcut(fullscreen)).toBe(false);
		expect(resolveShortcutId(fullscreen, { settingsOpen: false })).toBeNull();
		expect(resolveShortcutId(fullscreen, { settingsOpen: true })).toBeNull();
		expect(isFindShortcut(keyEvent({ key: "f", metaKey: true }))).toBe(true);
	});

	it.each([
		{ key: "f" },
		{ key: "f", ctrlKey: true },
		{ key: "f", metaKey: true, shiftKey: true },
		{ key: "f", metaKey: true, altKey: true },
		{ key: "g", metaKey: true },
	])("does not treat other macOS chords as find: %j", (init) => {
		expect(isFindShortcut(keyEvent(init))).toBe(false);
	});

	it.each([
		"windows",
		"linux",
	] as const)("preserves Ctrl+F on %s without Shift or Alt", (platform) => {
		vi.mocked(getPlatformOS).mockReturnValue(platform);
		expect(isFindShortcut(keyEvent({ key: "f", ctrlKey: true }))).toBe(true);
		expect(
			isFindShortcut(keyEvent({ key: "f", ctrlKey: true, shiftKey: true })),
		).toBe(false);
		expect(
			isFindShortcut(keyEvent({ key: "f", ctrlKey: true, altKey: true })),
		).toBe(false);
	});
});
