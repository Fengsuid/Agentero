/**
 * React-facing settings mirror (zustand vanilla). `lib/settings` keeps its
 * module cache + Tauri sync semantics; this store adds change notifications
 * for local saves so components can subscribe with selectors instead of the
 * old App-level useState copy.
 */

import { createStore } from "zustand/vanilla";
import {
	type AppSettings,
	loadSettings,
	saveSettings,
	subscribeSettings,
} from "@/lib/settings";

export const settingsStore = createStore<AppSettings>(() => loadSettings());

let synced = false;

/** Start mirroring cross-window settings snapshots; call once after boot. */
export function initSettingsStore(): void {
	if (synced) return;
	synced = true;
	settingsStore.setState(loadSettings(), true);
	subscribeSettings((next) => {
		const prev = settingsStore.getState();
		if (JSON.stringify(prev) === JSON.stringify(next)) return;
		// Merge only top-level fields whose content actually changed: the
		// broadcast snapshot carries fresh identities for every nested
		// object/array (cloneSettings on the sender side), and a wholesale
		// replace would re-render subscribers of untouched domains (e.g.
		// libraryColumns → the whole Library panel). Settings are small and
		// cross-window sync is rare, so JSON content comparison per field is
		// cheap; unchanged fields keep their old references so selectors bail.
		const changed: Partial<AppSettings> = {};
		const sink = changed as Record<string, unknown>;
		for (const key of Object.keys(next) as (keyof AppSettings)[]) {
			const before = prev[key];
			const after = next[key];
			const differs =
				after !== null && typeof after === "object"
					? JSON.stringify(before) !== JSON.stringify(after)
					: before !== after;
			if (differs) sink[key] = after;
		}
		settingsStore.setState({ ...prev, ...changed }, true);
	});
}

export function getSettings(): AppSettings {
	return settingsStore.getState();
}

/** Persist and broadcast a full settings snapshot. */
function updateSettings(next: AppSettings): void {
	settingsStore.setState(next, true);
	saveSettings(next);
}

export function patchSettings(patch: Partial<AppSettings>): void {
	updateSettings({ ...settingsStore.getState(), ...patch });
}
