import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderPlus, Loader2, Settings2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isMobileApp, isTauri } from "@/lib/core/tauri";
import {
	configurePlugin,
	type InstalledPlugin,
	installPlugin,
	listPlugins,
	type PluginScope,
	removePlugin,
} from "@/lib/plugins/api";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

export function PluginsPane({ vaultPath }: { vaultPath: string | null }) {
	const { t, i18n } = useTranslation("settings");
	const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState<InstalledPlugin | null>(null);
	const available =
		isTauri() &&
		!isMobileApp() &&
		Boolean(vaultPath && !isRemoteVaultHandle(vaultPath));
	const fail = useCallback(
		(error: unknown) =>
			notifyError(t("plugins.failed"), { description: errorText(error) }),
		[t],
	);
	const reload = useCallback(async () => {
		if (available && vaultPath) setPlugins(await listPlugins(vaultPath));
	}, [available, vaultPath]);
	useEffect(() => {
		let active = true;
		if (available && vaultPath)
			void listPlugins(vaultPath)
				.then((rows) => {
					if (active) setPlugins(rows);
				})
				.catch(fail);
		const listener = available
			? listen("plugins:changed", () => {
					if (active) void reload().catch(fail);
				})
			: null;
		return () => {
			active = false;
			if (listener) void listener.then((stop) => stop());
		};
	}, [available, vaultPath, reload, fail]);
	async function action(work: () => Promise<unknown>) {
		if (busy) return;
		setBusy(true);
		try {
			await work();
			await reload();
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<PageTitle
				title={t("nav.plugins")}
				actions={
					<Button
						size="sm"
						variant="outline"
						disabled={!available || busy}
						onClick={() =>
							void action(async () => {
								const directory = await open({
									directory: true,
									multiple: false,
									title: t("plugins.install"),
								});
								if (directory) await installPlugin(directory);
							})
						}
					>
						{busy ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<FolderPlus className="size-4" />
						)}
						{t("plugins.install")}
					</Button>
				}
			/>
			{!available && (
				<p className="mb-4 text-sm text-muted-foreground">
					{t("plugins.localOnly")}
				</p>
			)}
			{available && plugins.length === 0 && (
				<p className="py-8 text-center text-sm text-muted-foreground">
					{t("plugins.empty")}
				</p>
			)}
			<SettingsGroup>
				{plugins.map((plugin) => {
					const manifest = plugin.manifest;
					const name =
						manifest.name[i18n.resolvedLanguage ?? "en"] ??
						manifest.name.en ??
						manifest.id;
					return (
						<SettingsRow
							key={manifest.id}
							label={name}
							description={`${manifest.id} · ${manifest.version}`}
						>
							<div className="flex items-center gap-2">
								<Button
									variant="ghost"
									size="icon-sm"
									disabled={busy}
									aria-label={t("plugins.configure", { name })}
									onClick={() => setEditing(plugin)}
								>
									<Settings2 className="size-4" />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									disabled={busy}
									aria-label={t("plugins.remove", { name })}
									onClick={() => void action(() => removePlugin(manifest.id))}
								>
									<Trash2 className="size-4" />
								</Button>
								<Switch
									checked={plugin.scope?.enabled ?? false}
									disabled={busy}
									aria-label={t("plugins.enable", { name })}
									onCheckedChange={(enabled) => {
										if (enabled) setEditing(plugin);
										else if (vaultPath && plugin.scope)
											void action(() =>
												configurePlugin(manifest.id, vaultPath, {
													...plugin.scope,
													grants: plugin.scope?.grants ?? [],
													settings: plugin.scope?.settings ?? {},
													enabled: false,
												}),
											);
									}}
								/>
							</div>
						</SettingsRow>
					);
				})}
			</SettingsGroup>
			{editing && vaultPath && (
				<PluginScopeDialog
					key={`${vaultPath}:${editing.manifest.id}`}
					plugin={editing}
					onClose={() => setEditing(null)}
					onSave={async (scope) => {
						await configurePlugin(editing.manifest.id, vaultPath, scope);
						setEditing(null);
						await reload();
					}}
				/>
			)}
		</>
	);
}

function PluginScopeDialog({
	plugin,
	onClose,
	onSave,
}: {
	plugin: InstalledPlugin;
	onClose: () => void;
	onSave: (scope: PluginScope) => Promise<void>;
}) {
	const { t, i18n } = useTranslation("settings");
	const manifest = plugin.manifest;
	const [grants, setGrants] = useState(plugin.scope?.grants ?? []);
	const [settings, setSettings] = useState<
		Record<string, string | number | boolean>
	>(() =>
		Object.fromEntries(
			manifest.settings.map((setting) => [
				setting.key,
				plugin.scope?.settings[setting.key] ?? setting.default,
			]),
		),
	);
	const [busy, setBusy] = useState(false);
	const label = (titles: Record<string, string>) =>
		titles[i18n.resolvedLanguage ?? "en"] ?? titles.en;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
		>
			<DialogContent
				className="max-h-[80vh] overflow-y-auto"
				aria-describedby={undefined}
			>
				<DialogHeader>
					<DialogTitle>{label(manifest.name) || manifest.id}</DialogTitle>
				</DialogHeader>
				<SettingsGroup>
					{manifest.permissions.map((permission) => (
						<SettingsRow
							key={permission}
							label={t(`plugins.permissions.${permission}`, {
								nsSeparator: false,
							})}
						>
							<Switch
								checked={grants.includes(permission)}
								aria-label={t(`plugins.permissions.${permission}`, {
									nsSeparator: false,
								})}
								disabled={busy}
								onCheckedChange={(enabled) =>
									setGrants((current) =>
										enabled
											? [...current, permission]
											: current.filter((p) => p !== permission),
									)
								}
							/>
						</SettingsRow>
					))}
				</SettingsGroup>
				{manifest.settings.length > 0 && (
					<SettingsGroup>
						{manifest.settings.map((setting) => (
							<SettingsRow
								key={setting.key}
								label={label(setting.title)}
								htmlFor={`plugin-setting-${setting.key}`}
							>
								{setting.kind === "boolean" ? (
									<Switch
										id={`plugin-setting-${setting.key}`}
										checked={Boolean(settings[setting.key])}
										disabled={busy}
										onCheckedChange={(value) =>
											setSettings((old) => ({ ...old, [setting.key]: value }))
										}
									/>
								) : (
									<Input
										id={`plugin-setting-${setting.key}`}
										className="w-44"
										type={setting.kind === "number" ? "number" : "text"}
										value={String(settings[setting.key])}
										disabled={busy}
										onChange={(event) =>
											setSettings((old) => ({
												...old,
												[setting.key]:
													setting.kind === "number"
														? Number(event.target.value)
														: event.target.value,
											}))
										}
									/>
								)}
							</SettingsRow>
						))}
					</SettingsGroup>
				)}
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={onClose}>
						{t("plugins.cancel")}
					</Button>
					<Button
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await onSave({ enabled: true, grants, settings });
							} catch (error) {
								notifyError(t("plugins.failed"), {
									description: errorText(error),
								});
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy && <Loader2 className="size-4 animate-spin" />}
						{t("plugins.saveEnable")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
