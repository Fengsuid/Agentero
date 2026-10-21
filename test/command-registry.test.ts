import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	listCommands,
	registerBuiltinCommands,
	registerCommand,
	resetCommandRegistryForTests,
} from "@/lib/shell/commands/registry";
import {
	type AppCommand,
	commandCategory,
	commandTitle,
} from "@/lib/shell/commands/types";

// @ts-expect-error a command needs titleKey or a plain title
const _missingTitle: AppCommand = { id: "missing", run() {} };
// @ts-expect-error a command has one title form, not both
const _bothTitles: AppCommand = {
	id: "both",
	title: "Plain",
	titleKey: "commands.settingsOpen",
	run() {},
};
void _missingTitle;
void _bothTitles;

function external(id: string, title: string): AppCommand {
	return {
		id,
		title,
		run() {},
	};
}

function builtin(id: string, titleKey: string): AppCommand {
	return {
		id,
		titleKey,
		run() {},
	};
}

beforeEach(() => {
	resetCommandRegistryForTests();
});

describe("command registry", () => {
	it("lists builtin commands before external commands", () => {
		const externalA = external("ext.a", "External A");
		registerCommand(externalA);
		const builtinA = builtin("built.a", "commands.settingsOpen");
		registerCommand(builtinA, "builtin");
		const externalB = external("ext.b", "External B");
		registerCommand(externalB);
		const builtinB = builtin("built.b", "commands.vaultOpen");
		registerCommand(builtinB, "builtin");

		expect(listCommands()).toEqual([builtinA, builtinB, externalA, externalB]);
	});

	it("rejects a duplicate id and keeps the first command", () => {
		const first = external("shared", "First");
		registerCommand(first);
		const registerDuplicate = () =>
			registerCommand(external("shared", "Second"));

		expect(registerDuplicate).toThrow(Error);
		expect(registerDuplicate).toThrow(/shared/);
		expect(listCommands()).toEqual([first]);
	});

	it("unregister removes only that registration", () => {
		const first = external("shared", "First");
		const other = external("other", "Other");
		const unregisterFirst = registerCommand(first);
		const unregisterOther = registerCommand(other);

		expect(() => registerCommand(external("shared", "Duplicate"))).toThrow(
			/shared/,
		);
		expect(listCommands()).toEqual([first, other]);

		unregisterFirst();
		expect(listCommands()).toEqual([other]);

		const replacement = external("shared", "Replacement");
		registerCommand(replacement);
		unregisterFirst();
		expect(listCommands()).toEqual([other, replacement]);

		unregisterOther();
		expect(listCommands()).toEqual([replacement]);
	});

	it("does not apply when", () => {
		const when = vi.fn(() => false);
		const hidden: AppCommand = {
			id: "hidden",
			title: "Hidden",
			when,
			run() {},
		};

		registerCommand(hidden);

		expect(listCommands()).toEqual([hidden]);
		expect(when).not.toHaveBeenCalled();
	});

	it("returns a plain title without calling t", () => {
		const command = {
			id: "plugin.hello",
			title: "Hello from plugin",
			category: "Tools",
			run() {},
		} satisfies AppCommand;
		const t = vi.fn((key: string) => {
			throw new Error(`t should not be called (${key})`);
		});

		expect(commandTitle(command, t)).toBe("Hello from plugin");
		expect(commandCategory(command, t)).toBe("Tools");
		expect(t).not.toHaveBeenCalled();
	});

	it("registerBuiltinCommands twice does not throw or duplicate ids", () => {
		const commands = [
			builtin("settings.open", "commands.settingsOpen"),
			builtin("vault.open", "commands.vaultOpen"),
		];
		registerBuiltinCommands(commands);
		const extra = external("plugin.extra", "Extra");
		registerCommand(extra);

		const added = builtin("tab.close", "commands.tabClose");
		expect(() =>
			registerBuiltinCommands([
				builtin("settings.open", "commands.settingsOpen"),
				added,
			]),
		).not.toThrow();

		expect(listCommands()).toEqual([commands[0], commands[1], added, extra]);
	});
});
