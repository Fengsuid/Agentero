/**
 * In-process menu contributions. Built-in items stay in each menu's JSX.
 * A surface appends a separator and then these items only when
 * `visibleMenuContributions` is non-empty.
 *
 * Nothing in production registers a contribution. The list stays empty until
 * a test or a later host registers one. `resetMenuContributionsForTests` is
 * for tests only.
 */

import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { listCommands } from "@/lib/shell/commands/registry";

export type MenuId = "fileTree.item" | "library.row" | "pdf.selection";

export type MenuContext = {
	vaultPath: string | null;
	relPath?: string;
	paperId?: string;
	selectionText?: string;
};

export type MenuContribution = {
	id: string;
	menu: MenuId;
	commandId: string;
	/** Plain string, not an i18n key. */
	title: string;
	/** Default 0. Lower first. Ties keep registration order. */
	order?: number;
	when?: (ctx: MenuContext) => boolean;
};

type Entry = {
	contribution: MenuContribution;
	seq: number;
};

const entries: Entry[] = [];
let nextSeq = 0;

/**
 * Register one contribution. Duplicate ids throw and keep the first.
 * The disposer removes this registration only (object identity).
 */
export function registerMenuContribution(
	contribution: MenuContribution,
): () => void {
	if (entries.some((entry) => entry.contribution.id === contribution.id)) {
		throw new Error(
			`Menu contribution id already registered: ${contribution.id}`,
		);
	}
	const entry: Entry = { contribution, seq: nextSeq };
	nextSeq += 1;
	entries.push(entry);
	return () => {
		const index = entries.indexOf(entry);
		if (index >= 0) entries.splice(index, 1);
	};
}

/**
 * Visible contributions for `menu`: matching menu, `when` not false, and
 * `commandId` currently returned by `listCommands`. A missing command is
 * hidden. A `when` that throws hides that item and leaves the others.
 * This does not apply the command's own `when`.
 */
export function menuContributions(
	menu: MenuId,
	ctx: MenuContext,
): MenuContribution[] {
	const commandIds = new Set(listCommands().map((command) => command.id));
	return entries
		.filter((entry) => {
			const contribution = entry.contribution;
			if (contribution.menu !== menu) return false;
			if (!whenAllows(contribution, ctx)) return false;
			return commandIds.has(contribution.commandId);
		})
		.sort((a, b) => {
			const order = (a.contribution.order ?? 0) - (b.contribution.order ?? 0);
			if (order !== 0) return order;
			return a.seq - b.seq;
		})
		.map((entry) => entry.contribution);
}

/**
 * Same list as `menuContributions`. Menus render a trailing separator only
 * when this is non-empty.
 */
export function visibleMenuContributions(
	menu: MenuId,
	ctx: MenuContext,
): MenuContribution[] {
	return menuContributions(menu, ctx);
}

/**
 * Run the contribution's command. A missing command returns without throwing.
 * Synchronous throws propagate. A returned promise is not caught here.
 * Menus call {@link activateMenuContribution} instead.
 */
export function runMenuContribution(
	contribution: MenuContribution,
	context?: MenuContext,
): void | Promise<void> {
	const command = listCommands().find(
		(entry) => entry.id === contribution.commandId,
	);
	if (!command) return;
	return command.run(context);
}

/**
 * Run the contribution and toast failures with `notifyError(errorText)`.
 * Does not throw. A synchronous throw and a rejected promise both toast.
 */
export function activateMenuContribution(
	contribution: MenuContribution,
	context?: MenuContext,
): void {
	let pending: void | Promise<void>;
	try {
		pending = runMenuContribution(contribution, context);
	} catch (error) {
		notifyError(errorText(error));
		return;
	}
	if (pending instanceof Promise) {
		void pending.catch((error: unknown) => {
			notifyError(errorText(error));
		});
	}
}

/** `when` false or a throw hides the item. A missing `when` allows it. */
function whenAllows(contribution: MenuContribution, ctx: MenuContext): boolean {
	if (!contribution.when) return true;
	try {
		return contribution.when(ctx) !== false;
	} catch {
		return false;
	}
}

/** Clears the list. Tests only. */
export function resetMenuContributionsForTests(): void {
	entries.length = 0;
	nextSeq = 0;
}
