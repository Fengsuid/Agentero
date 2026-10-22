/**
 * Live outline of the active TeX editor. The editor publishes; the sidebar
 * panel only reads. Kept next to the flush registry so workspace UI does
 * not import the CodeMirror chunk.
 */

import { createStore } from "zustand/vanilla";
import type { TexOutlineItem } from "@/lib/tex/outline";
import { normalizeTabPath } from "@/lib/workspace/tabs";

export type TexOutlineSnapshot = {
	path: string;
	items: TexOutlineItem[];
	cursorLine: number;
};

type TexOutlineState = {
	snapshot: TexOutlineSnapshot | null;
};

export const texOutlineStore = createStore<TexOutlineState>(() => ({
	snapshot: null,
}));

const owners = new Map<string, symbol>();
const jumpers = new Map<string, (line: number) => void>();

/**
 * The active editor owns the snapshot for `path`. A later bind (split pane
 * becoming active) replaces the owner; the previous unbind does not clear
 * the new snapshot.
 */
export function bindTexOutline(path: string): {
	publish: (items: TexOutlineItem[], cursorLine: number) => void;
	unbind: () => void;
} {
	const key = normalizeTabPath(path);
	const token = Symbol(key);
	owners.set(key, token);
	return {
		publish(items, cursorLine) {
			if (owners.get(key) !== token) return;
			texOutlineStore.setState({
				snapshot: { path: key, items, cursorLine },
			});
		},
		unbind() {
			if (owners.get(key) !== token) return;
			owners.delete(key);
			const current = texOutlineStore.getState().snapshot;
			if (current?.path === key) {
				texOutlineStore.setState({ snapshot: null });
			}
		},
	};
}

export function registerTexOutlineJump(
	path: string,
	jump: (line: number) => void,
): () => void {
	const key = normalizeTabPath(path);
	jumpers.set(key, jump);
	return () => {
		if (jumpers.get(key) === jump) jumpers.delete(key);
	};
}

export function jumpTexOutline(path: string, line: number): void {
	jumpers.get(normalizeTabPath(path))?.(line);
}
