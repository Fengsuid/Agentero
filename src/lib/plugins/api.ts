import { commands } from "@/lib/core/bindings";
import { callResult } from "@/lib/core/ipc";
import type { PublicLifecycleEvent } from "@/lib/lifecycle/public";
import type { MenuId } from "@/lib/shell/commands/menu-contributions";

export type PluginPermission =
	| "vault:read"
	| "catalog:write"
	| "vault:notes:write"
	| "vault:write";
export type PluginManifest = {
	apiVersion: number;
	id: string;
	version: string;
	name: Record<string, string>;
	permissions: PluginPermission[];
	commands: Array<{ id: string; title: Record<string, string> }>;
	menus: Array<{ command: string; menu: MenuId; order: number }>;
	events: PublicLifecycleEvent[];
	settings: Array<{
		key: string;
		title: Record<string, string>;
		kind: "string" | "number" | "boolean";
		default: string | number | boolean;
	}>;
};
export type PluginScope = {
	enabled: boolean;
	grants: PluginPermission[];
	settings: Record<string, string | number | boolean>;
};
export type InstalledPlugin = {
	manifest: PluginManifest;
	scope: PluginScope | null;
};
export async function listPlugins(vault: string): Promise<InstalledPlugin[]> {
	return (await callResult(() =>
		commands.pluginList(vault),
	)) as unknown as InstalledPlugin[];
}
export const installPlugin = (directory: string) =>
	callResult(() => commands.pluginInstall(directory));
export const removePlugin = (id: string) =>
	callResult(() => commands.pluginRemove(id));
export const configurePlugin = (
	id: string,
	vault: string,
	scope: PluginScope,
) =>
	callResult(() =>
		commands.pluginConfigure(
			id,
			vault,
			scope.enabled,
			scope.grants,
			scope.settings,
		),
	);
