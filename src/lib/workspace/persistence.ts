/**
 * Save open editors and reload them when the file changes on disk.
 */

import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError, notifyUndo, notifyWarning } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { localFileToArrayBuffer } from "@/lib/paper";
import {
	isMarkdownPath,
	readVaultFile,
	vaultRelativePath,
	writeVaultFile,
} from "@/lib/vault";
import { primeSeedCache } from "@/lib/vault/seed-cache";
import { getVaultPath } from "@/lib/vault/store";
import { trackSelfWrittenPath } from "@/lib/wiki/store";
import { getTabs, setTabs } from "@/lib/workspace/store";
import {
	type DocTab,
	normalizeTabPath,
	refreshPdfTab,
	seedTabs,
	syncTabSeedsForPath,
} from "./tabs";
import { viewerModeSpec } from "./viewer";

/** Collect vault-relative paths with unsaved edits (rename preflight). */
export function dirtyVaultPaths(root: string): string[] {
	const dirty = new Set<string>();
	for (const tab of getTabs()) {
		if (tab.markdownDirty) {
			const rel = vaultRelativePath(root, tab.path);
			if (rel) dirty.add(rel);
		}
		if (tab.notesDirty && tab.notesPath) {
			const rel = vaultRelativePath(root, tab.notesPath);
			if (rel) dirty.add(rel);
		}
	}
	return [...dirty];
}

/** Normalized paths currently being reloaded from disk; suppresses any racing
 * editor autosave so an external/Agent write is never clobbered by stale
 * in-memory text. */
const reseedGuard = new Set<string>();

/** The editors that autosave through the shared persist pipeline. */
type PersistKind = "markdown" | "excalidraw" | "text";

/** Serialized saves per kind, keyed by normalized absolute path: overlapping
 * editor lifecycles cannot race their disk snapshot checks and writes. */
const persistQueues: Record<PersistKind, Map<string, Promise<boolean>>> = {
	markdown: new Map(),
	excalidraw: new Map(),
	text: new Map(),
};

/** Post-write outcome per kind, run only after the write is confirmed. */
const persistOutcomes: Record<
	PersistKind,
	(path: string, content: string) => void
> = {
	markdown: (path, content) => {
		primeSeedCache(path, content);
		// The Markdown editor keeps live content: only the owning tab's seed
		// advances (dirty state stays editor-owned).
		setTabs((prev) => syncTabSeedsForPath(prev, path, content));
	},
	excalidraw: (path, content) => {
		setTabs((prev) => seedTabs(prev, path, content, "excalidraw"));
	},
	text: (path, content) => {
		setTabs((prev) => seedTabs(prev, path, content, "text"));
		// NOTE: autosave only writes — .tex compiles are manual now
		// (⌘S / compile button); see compileTexOnManualSave.
	},
};

/**
 * Where disk-change reseeds land. The main window uses the workspace tab
 * store; doc popout windows pass a single-tab sink over local React state.
 * Both run the same pure tab-list transforms (`seedTabs` / `refreshPdfTab`).
 */
export type DiskChangeSink = {
	getTabs: () => DocTab[];
	/** Apply a tab-list transform to this window's panel list. */
	updateTabs: (update: (prev: DocTab[]) => DocTab[]) => void;
};

const defaultDiskChangeSink: DiskChangeSink = {
	getTabs,
	updateTabs: (update) => setTabs(update),
};

/** One text-like editor kind for disk-change reseeding: which open tabs own
 * the path plus the tab fields holding its in-memory seed / dirty flag. */
type DiskChangeKind = {
	/** Open tabs whose editor renders this path (notes: via the paper pairing). */
	owns: (tab: DocTab, norm: string) => boolean;
	/** Tab fields holding this editor's in-memory seed / unsaved-edits flag. */
	seed: "notesSeed" | "markdownSeed" | "excalidrawSeed" | "textSeed";
	dirty: "notesDirty" | "markdownDirty" | "excalidrawDirty" | "textDirty";
	/** External-write reseed transform (pure: the sink applies it to its tabs). */
	refresh: (prev: DocTab[], absPath: string, content: string) => DocTab[];
};

const diskChangeKinds: DiskChangeKind[] = [
	{
		owns: (tab, norm) =>
			Boolean(tab.notesPath && normalizeTabPath(tab.notesPath) === norm),
		seed: "notesSeed",
		dirty: "notesDirty",
		refresh: (prev, absPath, content) =>
			seedTabs(
				prev,
				absPath.replace(/[\\/]NOTES\.md$/i, ""),
				content,
				"notes",
				true,
			),
	},
	{
		owns: (tab, norm) =>
			normalizeTabPath(tab.path) === norm && isMarkdownPath(tab.path),
		seed: "markdownSeed",
		dirty: "markdownDirty",
		refresh: (prev, absPath, content) =>
			seedTabs(prev, absPath, content, "markdown", true),
	},
	{
		owns: (tab, norm) =>
			normalizeTabPath(tab.path) === norm && tab.mode === "excalidraw",
		seed: "excalidrawSeed",
		dirty: "excalidrawDirty",
		refresh: (prev, absPath, content) =>
			seedTabs(prev, absPath, content, "excalidraw", true),
	},
	{
		owns: (tab, norm) =>
			normalizeTabPath(tab.path) === norm && tab.mode === "text",
		seed: "textSeed",
		dirty: "textDirty",
		refresh: (prev, absPath, content) =>
			seedTabs(prev, absPath, content, "text", true),
	},
];

/**
 * Reload an open editor when its file changed on disk (external editor /
 * Agent). Reseeds only when disk content differs from the current seed —
 * equal content means it was our own autosave. The mounted editor reloads the
 * new seed in place (no remount); the path is guarded briefly so a racing
 * autosave cannot overwrite the fresh disk text.
 */
export async function applyDiskChange(
	absPath: string,
	sink: DiskChangeSink = defaultDiskChangeSink,
): Promise<void> {
	const norm = normalizeTabPath(absPath);
	const openTabs = sink.getTabs();
	const kindOwners = diskChangeKinds.map((kind) => ({
		kind,
		owners: openTabs.filter((tab) => kind.owns(tab, norm)),
	}));
	const pdfOwners = openTabs.filter(
		(t) =>
			normalizeTabPath(t.path) === norm &&
			viewerModeSpec(t.mode).resource === "pdf",
	);
	const hasTextOwners = kindOwners.some((entry) => entry.owners.length > 0);
	if (!hasTextOwners && !pdfOwners.length) return;
	// PDF panes reload from bytes: one read feeds every matching pane (source
	// tab + translation split); the fresh ArrayBuffer identity is the mounted
	// viewer's reload signal. Panes still on the compile shimmer are skipped
	// inside refreshPdfTab — the compile flow fills them when the run lands.
	if (pdfOwners.length) {
		const bytes = await localFileToArrayBuffer(absPath);
		if (bytes) sink.updateTabs((prev) => refreshPdfTab(prev, absPath, bytes));
	}
	if (!hasTextOwners) return;
	let content: string;
	try {
		content = await readVaultFile(absPath);
	} catch {
		return;
	}
	// Keep the open-path seed cache in step with what the reload just read.
	primeSeedCache(absPath, content);
	const guard = () => {
		reseedGuard.add(norm);
		window.setTimeout(() => reseedGuard.delete(norm), 500);
	};
	const promptReload = (reload: () => void) => {
		const name = absPath.split(/[\\/]/).pop() ?? absPath;
		notifyUndo(i18n.t("app:diskConflict.title", { name }), {
			actionLabel: i18n.t("app:diskConflict.reload"),
			onAction: reload,
			duration: 12000,
		});
	};
	for (const { kind, owners } of kindOwners) {
		for (const tab of owners) {
			if (content === tab[kind.seed]) continue;
			const reload = () => {
				guard();
				sink.updateTabs((prev) => kind.refresh(prev, absPath, content));
			};
			if (tab[kind.dirty]) promptReload(reload);
			else reload();
		}
	}
}

/**
 * Shared autosave pipeline for the text-like editors (Markdown / Excalidraw /
 * plain text): per-path serialization, disk-conflict guard, self-write echo
 * registration, then the kind's post-write reseed.
 */
function persistTextLike(
	kind: PersistKind,
	path: string,
	content: string,
	lastSaved: string,
): Promise<boolean> {
	if (!isTauri() || !getVaultPath() || !path) return Promise.resolve(false);
	const queues = persistQueues[kind];
	const normalizedPath = normalizeTabPath(path);
	const previous = queues.get(normalizedPath) ?? Promise.resolve(false);
	const attempt = previous
		.catch(() => false)
		.then(async () => {
			// Skip while this path is being reloaded from disk (external/Agent
			// write): the unmount-flush must not clobber the fresh disk content.
			if (reseedGuard.has(normalizedPath)) return false;
			// Conflict guard: if the file changed on disk since we last saved,
			// do NOT silently overwrite — keep the user's in-memory edit and warn.
			try {
				const disk = await readVaultFile(path);
				if (disk !== lastSaved) {
					const name = path.split(/[\\/]/).pop() ?? path;
					notifyWarning(i18n.t("app:diskConflict.saveBlocked", { name }));
					return false;
				}
			} catch {
				// Missing/unreadable file → no conflict to guard against.
			}
			try {
				await writeVaultFile(path, content);
				// The watcher echo of this write must not re-trigger a full Wiki
				// rebuild on every autosave (#270).
				trackSelfWrittenPath(path);
				persistOutcomes[kind](path, content);
				return true;
			} catch (e) {
				notifyError(errorText(e));
				return false;
			}
		});
	queues.set(normalizedPath, attempt);
	// Drop the queue entry once this attempt settles and is still the tail.
	const settle = () => {
		if (queues.get(normalizedPath) === attempt) queues.delete(normalizedPath);
	};
	void attempt.then(settle, settle);
	return attempt;
}

/**
 * Persist a specific file's Markdown to disk. The MarkdownEditor calls this
 * with its own fixed path (debounced autosave, ⌘S, and unmount flush), so
 * writes always target the correct file even when switching files quickly.
 */
export function persistFile(
	path: string,
	md: string,
	lastSaved: string,
): Promise<boolean> {
	return persistTextLike("markdown", path, md, lastSaved);
}

/**
 * Persist a specific `.excalidraw` file to disk. The ExcalidrawViewer calls
 * this with its own fixed path (debounced autosave and unmount flush).
 */
export function persistExcalidrawFile(
	path: string,
	json: string,
	lastSaved: string,
): Promise<boolean> {
	return persistTextLike("excalidraw", path, json, lastSaved);
}

/**
 * Persist a plain-text editor file to disk. The CodeMirror TextEditor calls
 * this with its own fixed path (debounced autosave and unmount flush).
 */
export function persistTextFile(
	path: string,
	content: string,
	lastSaved: string,
): Promise<boolean> {
	return persistTextLike("text", path, content, lastSaved);
}
