/**
 * In-process palette registry. Builtins register explicitly; omitting
 * `source` records an external command. Duplicate ids throw and keep the
 * first registration. `listCommands` does not apply `when`.
 *
 * Shell shortcuts stay bound to built-in ids in `shortcuts.ts`. This
 * registry does not look them up, so an external command cannot take one.
 */

import type { AppCommand } from "@/lib/shell/commands/types";

export type CommandSource = "builtin" | "external";

type Registration = {
	command: AppCommand;
};

const builtins: Registration[] = [];
const externals: Registration[] = [];
const listeners = new Set<() => void>();
let revision = 0;

export const commandRegistryRevision = () => revision;

export function subscribeCommands(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function changed(): void {
	revision += 1;
	for (const listener of listeners) listener();
}

function findRegistration(id: string): Registration | undefined {
	return (
		builtins.find((entry) => entry.command.id === id) ??
		externals.find((entry) => entry.command.id === id)
	);
}

/** Builtin registration order, then external registration order. */
export function listCommands(): AppCommand[] {
	return [
		...builtins.map((entry) => entry.command),
		...externals.map((entry) => entry.command),
	];
}

/**
 * Register one command. Defaults to `"external"`.
 * The disposer removes this registration only while it is still the entry
 * that was stored (object identity). A rejected duplicate does not return
 * a disposer, and a later command with the same id is left in place.
 */
export function registerCommand(
	command: AppCommand,
	source: CommandSource = "external",
): () => void {
	if (findRegistration(command.id)) {
		throw new Error(`Command id already registered: ${command.id}`);
	}
	const entry: Registration = { command };
	const list = source === "builtin" ? builtins : externals;
	list.push(entry);
	changed();
	return () => {
		const index = list.indexOf(entry);
		if (index >= 0) {
			list.splice(index, 1);
			changed();
		}
	};
}

/**
 * Register each command as builtin. Ids already present are skipped so a
 * second evaluation (HMR or a test reimport) does not throw or duplicate.
 */
export function registerBuiltinCommands(commands: readonly AppCommand[]): void {
	for (const command of commands) {
		if (findRegistration(command.id)) continue;
		registerCommand(command, "builtin");
	}
}

/** Clears both lists. Tests only. */
export function resetCommandRegistryForTests(): void {
	builtins.length = 0;
	externals.length = 0;
	changed();
}
