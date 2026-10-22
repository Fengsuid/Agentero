import { create } from "zustand";

export type TexLiveStatus =
	| "starting"
	| "live"
	| "waiting"
	| "restarting"
	| "failed";

type PreviewStatus = { status: TexLiveStatus; error: string | null };

/** Ephemeral preview state shared with the workspace tab; never persisted. */
export const useTexLiveStatusStore = create<{
	byRoot: Record<string, PreviewStatus>;
	setStatus: (rootPath: string, status: PreviewStatus, owner: symbol) => void;
	clearStatus: (rootPath: string, owner: symbol) => void;
}>((set) => {
	const publishers = new Map<string, Map<symbol, PreviewStatus>>();
	return {
		byRoot: {},
		setStatus: (rootPath, status, owner) => {
			const entries =
				publishers.get(rootPath) ?? new Map<symbol, PreviewStatus>();
			// Retain each pane independently, ordered by its latest update.
			entries.delete(owner);
			entries.set(owner, status);
			publishers.set(rootPath, entries);
			set((state) => ({ byRoot: { ...state.byRoot, [rootPath]: status } }));
		},
		clearStatus: (rootPath, owner) => {
			const entries = publishers.get(rootPath);
			if (!entries?.delete(owner)) return;
			const remaining = [...entries.values()].at(-1);
			if (!remaining) publishers.delete(rootPath);
			set((state) => {
				const byRoot = { ...state.byRoot };
				if (remaining) byRoot[rootPath] = remaining;
				else delete byRoot[rootPath];
				return { byRoot };
			});
		},
	};
});
