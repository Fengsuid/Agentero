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
	setStatus: (rootPath: string, status: PreviewStatus) => void;
	clearStatus: (rootPath: string) => void;
}>((set) => ({
	byRoot: {},
	setStatus: (rootPath, status) =>
		set((state) => ({ byRoot: { ...state.byRoot, [rootPath]: status } })),
	clearStatus: (rootPath) =>
		set((state) => {
			const byRoot = { ...state.byRoot };
			delete byRoot[rootPath];
			return { byRoot };
		}),
}));
