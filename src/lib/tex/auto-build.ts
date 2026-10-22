import { events } from "@/lib/core/bindings";
import { normalizePath } from "@/lib/core/path";
import { listenEventSafe } from "@/lib/core/tauri-events";
import { setTexDependencies, texBuildStore } from "@/lib/tex/build-state";
import {
	getTexProjectSettings,
	texBuildOptions,
	texSettingsStore,
} from "@/lib/tex/config";
import { inspectLatexProject } from "@/lib/tex/host";
import { vaultStore } from "@/lib/vault/store";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Set<string>();
let buildRunner: ((rootPath: string) => Promise<void>) | null = null;

export function registerTexAutoBuildRunner(
	run: (rootPath: string) => Promise<void>,
): void {
	buildRunner = run;
}
const INPUT_EXCLUDES =
	/\.(?:aux|log|fls|fdb_latexmk|synctex(?:\.gz)?|toc|lof|lot|bbl|blg|bcf|run\.xml|nav|snm|vrb|xdv|dvi|out)$/i;

export function isTexDependencyChange(
	path: string,
	dependencies: readonly string[],
): boolean {
	const normalized = normalizePath(path);
	return (
		!INPUT_EXCLUDES.test(normalized) &&
		dependencies.some((dependency) => normalizePath(dependency) === normalized)
	);
}

function isCurrentVaultRoot(root: string): boolean {
	const vault = vaultStore.getState().vaultPath;
	return !!vault && normalizePath(root).startsWith(`${normalizePath(vault)}/`);
}

export async function trackTexProject(rootPath: string): Promise<void> {
	try {
		const project = await inspectLatexProject(
			rootPath,
			vaultStore.getState().vaultPath ?? "",
			rootPath,
			texBuildOptions(rootPath),
		);
		setTexDependencies(rootPath, [
			...project.texFiles,
			...project.bibFiles,
			...project.dependencies,
		]);
	} catch {
		/* Compilation still works before an initial project inspection succeeds. */
	}
}

export function scheduleTexAutoBuild(rootPath: string): void {
	const root = normalizePath(rootPath);
	const timer = timers.get(root);
	if (timer) clearTimeout(timer);
	timers.set(
		root,
		setTimeout(() => {
			timers.delete(root);
			if (
				!isCurrentVaultRoot(root) ||
				getTexProjectSettings(root).autoBuild === "never"
			)
				return;
			pending.add(root);
			void drainAutoBuilds();
		}, 1000),
	);
}

/** A build that already includes the saved bytes satisfies a pending auto trigger. */
export function cancelScheduledTexAutoBuild(rootPath: string): void {
	const root = normalizePath(rootPath);
	const timer = timers.get(root);
	if (timer) clearTimeout(timer);
	timers.delete(root);
	pending.delete(root);
}

let draining = false;
async function drainAutoBuilds(): Promise<void> {
	if (draining) return;
	draining = true;
	try {
		while (pending.size && buildRunner) {
			const root = pending.values().next().value;
			if (!root) break;
			pending.delete(root);
			if (
				isCurrentVaultRoot(root) &&
				getTexProjectSettings(root).autoBuild !== "never"
			) {
				await buildRunner(root);
			}
		}
	} finally {
		draining = false;
	}
}

/** Explicit save hooks include .bib/.sty/.cls, which may not have a TeX editor. */
export function onTexFileSaved(path: string): void {
	if (INPUT_EXCLUDES.test(path)) return;
	const roots = new Set([
		...Object.keys(texBuildStore.getState().dependencies),
		...Object.keys(texSettingsStore.getState().projects),
	]);
	for (const root of roots) {
		if (getTexProjectSettings(root).autoBuild !== "onSave") continue;
		if (
			isTexDependencyChange(
				path,
				texBuildStore.getState().dependencies[root] ?? [root],
			)
		)
			scheduleTexAutoBuild(root);
	}
}

let started = false;
export function startTexAutoBuild(): void {
	if (started) return;
	started = true;
	listenEventSafe(events.vaultFileChanged, ({ paths }) => {
		for (const [root, dependencies] of Object.entries(
			texBuildStore.getState().dependencies,
		)) {
			if (getTexProjectSettings(root).autoBuild !== "onFileChange") continue;
			if (paths.some((path) => isTexDependencyChange(path, dependencies)))
				scheduleTexAutoBuild(root);
		}
	});
	vaultStore.subscribe((state, previous) => {
		if (state.vaultPath === previous.vaultPath) return;
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		pending.clear();
	});
}
