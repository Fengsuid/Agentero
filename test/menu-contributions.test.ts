import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
}));

import { notifyError } from "@/lib/core/notify";
import type {
	MenuContext,
	MenuContribution,
	MenuId,
} from "@/lib/shell/commands/menu-contributions";
import {
	activateMenuContribution,
	menuContributions,
	registerMenuContribution,
	resetMenuContributionsForTests,
	runMenuContribution,
	visibleMenuContributions,
} from "@/lib/shell/commands/menu-contributions";
import {
	registerCommand,
	resetCommandRegistryForTests,
} from "@/lib/shell/commands/registry";
import type { AppCommand } from "@/lib/shell/commands/types";

const ctx: MenuContext = { vaultPath: "/vault", relPath: "papers/a" };

function command(
	id: string,
	run: () => void | Promise<void> = () => {},
): AppCommand {
	return { id, title: id, run };
}

function contribution(
	id: string,
	menu: MenuId,
	commandId = id,
	extra: Partial<MenuContribution> = {},
): MenuContribution {
	return {
		id,
		menu,
		commandId,
		title: id,
		...extra,
	};
}

beforeEach(() => {
	resetCommandRegistryForTests();
	resetMenuContributionsForTests();
	vi.mocked(notifyError).mockClear();
});

describe("menu contributions", () => {
	it("returns a contribution only for its menu", () => {
		registerCommand(command("plugin.tree"));
		const when = vi.fn(() => true);
		const item = contribution("tree", "fileTree.item", "plugin.tree", {
			when,
		});
		registerMenuContribution(item);

		expect(menuContributions("library.row", ctx)).toEqual([]);
		expect(menuContributions("pdf.selection", ctx)).toEqual([]);
		expect(when).not.toHaveBeenCalled();
		expect(menuContributions("fileTree.item", ctx)).toEqual([item]);
		expect(when).toHaveBeenCalledTimes(1);
		expect(when).toHaveBeenCalledWith(ctx);
	});

	it("hides a contribution whose when throws and keeps the rest", () => {
		registerCommand(command("plugin.bad"));
		registerCommand(command("plugin.ok"));
		registerMenuContribution(
			contribution("bad", "library.row", "plugin.bad", {
				when: () => {
					throw new Error("nope");
				},
			}),
		);
		const ok = contribution("ok", "library.row", "plugin.ok");
		registerMenuContribution(ok);

		expect(visibleMenuContributions("library.row", ctx)).toEqual([ok]);
	});

	it("hides a contribution when when returns false", () => {
		registerCommand(command("plugin.hidden"));
		registerMenuContribution(
			contribution("hidden", "library.row", "plugin.hidden", {
				when: () => false,
			}),
		);

		expect(menuContributions("library.row", ctx)).toEqual([]);
	});

	it("hides a contribution whose command is not registered", () => {
		registerMenuContribution(contribution("missing", "pdf.selection"));

		expect(menuContributions("pdf.selection", ctx)).toEqual([]);

		registerCommand(command("missing"));
		expect(
			menuContributions("pdf.selection", ctx).map((item) => item.id),
		).toEqual(["missing"]);
	});

	it("does not apply the command when", () => {
		const when = vi.fn(() => false);
		registerCommand({
			id: "plugin.palette-hidden",
			title: "Hidden in palette",
			when,
			run() {},
		});
		registerMenuContribution(
			contribution("show", "library.row", "plugin.palette-hidden"),
		);

		expect(
			menuContributions("library.row", ctx).map((item) => item.id),
		).toEqual(["show"]);
		expect(when).not.toHaveBeenCalled();
	});

	it("orders by order, then registration order", () => {
		for (const id of ["b", "a", "c", "d"]) registerCommand(command(id));
		registerMenuContribution(
			contribution("b", "library.row", "b", { order: 0 }),
		);
		registerMenuContribution(
			contribution("a", "library.row", "a", { order: 0 }),
		);
		registerMenuContribution(
			contribution("c", "library.row", "c", { order: -1 }),
		);
		registerMenuContribution(contribution("d", "library.row", "d"));

		expect(
			menuContributions("library.row", ctx).map((item) => item.id),
		).toEqual(["c", "b", "a", "d"]);
	});

	it("visibleMenuContributions is empty when a separator should not render", () => {
		expect(visibleMenuContributions("pdf.selection", ctx)).toEqual([]);

		registerCommand(command("plugin.pdf"));
		registerMenuContribution(
			contribution("pdf.one", "pdf.selection", "plugin.pdf"),
		);

		expect(
			visibleMenuContributions("pdf.selection", ctx).map((item) => item.id),
		).toEqual(["pdf.one"]);
		expect(visibleMenuContributions("fileTree.item", ctx)).toEqual([]);
	});

	it("rejects a duplicate id and keeps the first contribution", () => {
		registerCommand(command("plugin.shared"));
		const first = contribution("shared", "fileTree.item", "plugin.shared", {
			title: "First",
		});
		registerMenuContribution(first);
		const registerDuplicate = () =>
			registerMenuContribution(
				contribution("shared", "library.row", "plugin.shared", {
					title: "Second",
				}),
			);

		expect(registerDuplicate).toThrow(Error);
		expect(registerDuplicate).toThrow(/shared/);
		expect(menuContributions("fileTree.item", ctx)).toEqual([first]);
		expect(menuContributions("library.row", ctx)).toEqual([]);
	});

	it("unregister removes only that contribution", () => {
		registerCommand(command("plugin.shared"));
		registerCommand(command("plugin.other"));
		const first = contribution("shared", "library.row", "plugin.shared");
		const other = contribution("other", "library.row", "plugin.other");
		const unregisterFirst = registerMenuContribution(first);
		const unregisterOther = registerMenuContribution(other);

		expect(() =>
			registerMenuContribution(
				contribution("shared", "pdf.selection", "plugin.shared"),
			),
		).toThrow(/shared/);
		expect(menuContributions("library.row", ctx)).toEqual([first, other]);

		unregisterFirst();
		expect(menuContributions("library.row", ctx)).toEqual([other]);

		const replacement = contribution("shared", "library.row", "plugin.shared", {
			title: "Replacement",
		});
		registerMenuContribution(replacement);
		unregisterFirst();
		expect(menuContributions("library.row", ctx)).toEqual([other, replacement]);

		unregisterOther();
		expect(menuContributions("library.row", ctx)).toEqual([replacement]);
	});

	it("invoking a returned item runs the registered command", () => {
		const run = vi.fn();
		registerCommand(command("plugin.go", run));
		registerMenuContribution(contribution("go", "library.row", "plugin.go"));
		const [item] = visibleMenuContributions("library.row", ctx);

		activateMenuContribution(item);
		expect(run).toHaveBeenCalledOnce();
		expect(notifyError).not.toHaveBeenCalled();
	});

	it("activateMenuContribution toasts sync and async failures without throwing", async () => {
		registerCommand(
			command("plugin.sync", () => {
				throw new Error("sync");
			}),
		);
		registerCommand(
			command("plugin.async", () => Promise.reject(new Error("async"))),
		);
		registerMenuContribution(
			contribution("sync", "library.row", "plugin.sync"),
		);
		registerMenuContribution(
			contribution("async", "library.row", "plugin.async"),
		);
		const [syncItem, asyncItem] = menuContributions("library.row", ctx);

		expect(() => activateMenuContribution(syncItem)).not.toThrow();
		expect(notifyError).toHaveBeenCalledWith("sync");

		vi.mocked(notifyError).mockClear();
		activateMenuContribution(asyncItem);
		await vi.waitFor(() => {
			expect(notifyError).toHaveBeenCalledWith("async");
		});
	});

	it("lets a synchronous throw and a rejected promise propagate", async () => {
		registerCommand(
			command("plugin.sync", () => {
				throw new Error("sync");
			}),
		);
		registerCommand(
			command("plugin.async", () => Promise.reject(new Error("async"))),
		);
		registerMenuContribution(
			contribution("sync", "pdf.selection", "plugin.sync"),
		);
		registerMenuContribution(
			contribution("async", "pdf.selection", "plugin.async"),
		);
		const items = menuContributions("pdf.selection", ctx);

		expect(() => runMenuContribution(items[0])).toThrow("sync");
		await expect(runMenuContribution(items[1])).rejects.toThrow("async");
	});
});
