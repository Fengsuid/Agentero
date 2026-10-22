/** Session registrations are projections of Host-owned packages and grants. */

import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import i18n from "@/i18n";
import { commands, type DevelopmentPluginInfo } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callResult } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isMobileApp, isTauri } from "@/lib/core/tauri";
import { onPublic, type PublicLifecycleEvent } from "@/lib/lifecycle/public";
import { refreshLibrary } from "@/lib/paper/library-store";
import {
	type MenuContext,
	registerMenuContribution,
} from "@/lib/shell/commands/menu-contributions";
import { registerCommand } from "@/lib/shell/commands/registry";
import { vaultRelativePath } from "@/lib/vault/path";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { getVaultPath, vaultStore } from "@/lib/vault/store";
import { getActiveTab, getTabs, workspaceStore } from "@/lib/workspace/store";
import type { PluginManifest } from "./api";

type Entry = {
	info: DevelopmentPluginInfo;
	manifest: PluginManifest;
	dispose: () => void;
	queue: Promise<void>;
	pending: number;
	failures: number;
};
const loaded = new Map<string, Entry>();
let generation = 0;
let loading = false;
export function canLoadDevelopmentPlugin(): boolean {
	const vault = getVaultPath();
	return (
		import.meta.env.DEV &&
		isTauri() &&
		!isMobileApp() &&
		Boolean(vault && !isRemoteVaultHandle(vault))
	);
}
export const hasDevelopmentPlugins = () => loaded.size > 0;
const reportError = (error: unknown): void => {
	notifyError(i18n.t("app:plugins.failed"), { description: errorText(error) });
};
const label = (titles: Record<string, string>) =>
	titles[i18n.resolvedLanguage ?? "en"] ?? titles.en ?? "";
function blockedPaths(vault: string): string[] {
	const paths = new Set<string>();
	for (const tab of getTabs()) {
		if (tab.markdownDirty || tab.textDirty || tab.excalidrawDirty) {
			const rel = vaultRelativePath(vault, tab.path);
			if (rel) paths.add(rel);
		}
		if (tab.notesDirty && tab.notesPath) {
			const rel = vaultRelativePath(vault, tab.notesPath);
			if (rel) paths.add(rel);
		}
	}
	return [...paths];
}
function invoke(
	entry: Entry,
	vault: string,
	command: string,
	context?: MenuContext,
	kind = "command",
	event: string | null = null,
	payload: unknown = null,
): Promise<void> {
	const epoch = generation;
	const active = getActiveTab()?.paperMeta;
	const paperRef = context
		? (context.paperId ?? context.relPath ?? "")
		: (active?.path ?? "");
	const snapshot = {
		paperRef,
		locale: i18n.resolvedLanguage ?? "en",
		kind,
		event,
		relPath: context?.relPath ?? null,
		selectionText: context?.selectionText ?? null,
		payload,
		blockedPaths: blockedPaths(vault),
	};
	if (entry.pending >= 16)
		return Promise.reject(new Error("plugin_queue_full"));
	entry.pending += 1;
	const work = entry.queue.then(async () => {
		if (
			generation !== epoch ||
			getVaultPath() !== vault ||
			loaded.get(entry.info.pluginId) !== entry
		)
			return;
		try {
			await callResult(() =>
				commands.pluginEditorState(vault, blockedPaths(vault)),
			);
			const result = await callResult(() =>
				commands.pluginRun(entry.info.instanceId, command, {
					...snapshot,
					payload: snapshot.payload as never,
					blockedPaths: blockedPaths(vault),
				}),
			);
			entry.failures = 0;
			if (
				result &&
				kind === "command" &&
				generation === epoch &&
				loaded.get(entry.info.pluginId) === entry
			) {
				const title = entry.manifest.commands.find(
					(c) => c.id === command,
				)?.title;
				notifySuccess(title ? label(title) : entry.info.pluginId, {
					description: result,
				});
			}
		} catch (error) {
			if (generation !== epoch || loaded.get(entry.info.pluginId) !== entry)
				return;
			entry.failures += 1;
			if (entry.failures >= 3) {
				entry.dispose();
				loaded.delete(entry.info.pluginId);
				await commands.pluginUnload(entry.info.instanceId);
				notifyError(
					i18n.t("app:plugins.suspended", { name: entry.info.pluginId }),
				);
			}
			throw error;
		}
	});
	entry.queue = work
		.catch(() => {})
		.finally(() => {
			entry.pending -= 1;
		});
	return work;
}
function register(info: DevelopmentPluginInfo, vault: string): void {
	const manifest = info.manifest as unknown as PluginManifest;
	const previous = loaded.get(info.pluginId);
	previous?.dispose();
	const disposers: Array<() => void> = [];
	const entry: Entry = {
		info,
		manifest,
		dispose: () => {
			for (const dispose of disposers) dispose();
		},
		queue: Promise.resolve(),
		pending: 0,
		failures: 0,
	};
	loaded.set(info.pluginId, entry);
	try {
		for (const command of manifest.commands) {
			const id = `plugin:${manifest.id}:${command.id}`;
			disposers.push(
				registerCommand({
					id,
					get title() {
						return i18n.t("app:plugins.commandTitle", {
							title: label(command.title),
						});
					},
					when: () => getVaultPath() === vault,
					run: (ctx) =>
						invoke(entry, vault, command.id, ctx).catch(reportError),
				}),
			);
		}
		for (const [index, menu] of manifest.menus.entries()) {
			const command = manifest.commands.find((c) => c.id === menu.command);
			if (!command) continue;
			disposers.push(
				registerMenuContribution({
					id: `plugin:${manifest.id}:menu:${index}`,
					menu: menu.menu,
					commandId: `plugin:${manifest.id}:${command.id}`,
					order: menu.order,
					get title() {
						return i18n.t("app:plugins.commandTitle", {
							title: label(command.title),
						});
					},
					when: (ctx) => ctx.vaultPath === vault,
				}),
			);
		}
		for (const event of info.grants.includes("vault:read")
			? manifest.events
			: []) {
			if (event === "vault:opened") continue; // Delivered once after activation below.
			disposers.push(
				onPublic(
					event as Exclude<PublicLifecycleEvent, "vault:opened">,
					(payload) => {
						if ("vaultId" in payload && payload.vaultId !== vault) return;
						const scoped = { ...payload, vaultId: info.instanceId };
						void invoke(
							entry,
							vault,
							"",
							undefined,
							"event",
							event,
							scoped,
						).catch(reportError);
					},
				),
			);
		}
		void invoke(entry, vault, "", undefined, "activate")
			.then(() => {
				if (
					info.grants.includes("vault:read") &&
					manifest.events.includes("vault:opened")
				)
					return invoke(entry, vault, "", undefined, "event", "vault:opened", {
						vaultId: info.instanceId,
					});
			})
			.catch(reportError);
	} catch (error) {
		entry.dispose();
		loaded.delete(info.pluginId);
		void commands.pluginUnload(info.instanceId);
		throw error;
	}
}
export async function unloadDevelopmentPlugins(): Promise<void> {
	generation += 1;
	const entries = [...loaded.values()];
	loaded.clear();
	for (const entry of entries) entry.dispose();
	await Promise.all(
		entries.map(async (entry) => {
			// Best-effort graceful hook. Busy or already revoked instances are
			// cancelled immediately; cleanup must never delay an active command.
			if (entry.pending === 0) {
				await commands
					.pluginRun(entry.info.instanceId, "", {
						kind: "deactivate",
						paperRef: "",
						locale: i18n.resolvedLanguage ?? "en",
						event: null,
						relPath: null,
						selectionText: null,
						payload: null,
						blockedPaths: blockedPaths(getVaultPath() ?? ""),
					})
					.catch(() => {});
			}
			await commands.pluginUnload(entry.info.instanceId).catch(reportError);
		}),
	);
}
let restoreQueue: Promise<void> = Promise.resolve();
function restore(): Promise<void> {
	const cleanup = unloadDevelopmentPlugins();
	const epoch = generation,
		vault = getVaultPath();
	const task = restoreQueue.then(async () => {
		await cleanup;
		if (
			!vault ||
			isRemoteVaultHandle(vault) ||
			generation !== epoch ||
			getVaultPath() !== vault
		)
			return;
		const infos = await callResult(() => commands.pluginActivate(vault));
		if (generation !== epoch || getVaultPath() !== vault) {
			await Promise.all(
				infos.map((info) => commands.pluginUnload(info.instanceId)),
			);
			return;
		}
		for (const info of infos) register(info, vault);
	});
	restoreQueue = task.catch(() => {});
	return task;
}
export function startDevelopmentPlugins(): () => void {
	if (!isTauri() || isMobileApp()) return () => {};
	let stopped = false;
	const stopVault = vaultStore.subscribe((state, old) => {
		if (state.vaultPath !== old.vaultPath) void unloadDevelopmentPlugins();
	});
	const stopOpened = onPublic("vault:opened", () => {
		void restore().catch(reportError);
	});
	let previousDirty = "";
	const stopEditors = workspaceStore.subscribe(() => {
		const vault = getVaultPath();
		if (!vault || !loaded.size) return;
		const paths = blockedPaths(vault),
			key = JSON.stringify([vault, paths]);
		if (key === previousDirty) return;
		previousDirty = key;
		void commands.pluginEditorState(vault, paths).catch(reportError);
	});
	const listeners = [
		listen("plugins:changed", () => {
			if (!stopped) void restore().catch(reportError);
		}),
		listen<string>("plugins:data-changed", ({ payload }) => {
			if (!stopped && payload === getVaultPath()) void refreshLibrary();
		}),
	];
	return () => {
		stopped = true;
		stopVault();
		stopEditors();
		stopOpened();
		for (const listener of listeners) void listener.then((stop) => stop());
		void unloadDevelopmentPlugins();
	};
}
export async function loadDevelopmentPlugin(): Promise<void> {
	if (loading || !canLoadDevelopmentPlugin()) return;
	loading = true;
	const epoch = generation,
		vault = getVaultPath();
	try {
		const directory = await open({
			directory: true,
			multiple: false,
			title: i18n.t("app:plugins.chooseDirectory"),
		});
		if (
			!directory ||
			!vault ||
			generation !== epoch ||
			getVaultPath() !== vault
		)
			return;
		const info = await callResult(() =>
			commands.pluginDevLoad(directory, vault),
		);
		if (generation !== epoch || getVaultPath() !== vault) {
			await commands.pluginUnload(info.instanceId);
			return;
		}
		register(info, vault);
		notifySuccess(i18n.t("app:plugins.loaded"));
	} catch (error) {
		reportError(error);
	} finally {
		loading = false;
	}
}
