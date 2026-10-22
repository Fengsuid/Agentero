import type { EditorView, ViewUpdate } from "@codemirror/view";
import { commands } from "@/lib/core/bindings";
import { normalizeSlashes } from "@/lib/core/path";
import {
	ByteIndex,
	editsFromUpdate,
	firstChangedLine,
} from "@/lib/tex-live/byte-index";
import { normalizePathKey } from "@/lib/vault/path";

export type TexLiveSession = {
	id: string;
	rootPath: string;
	projectRoot: string;
	mainFile: string;
	/** Mounted preview panes using this session; 0 schedules a delayed stop. */
	refs: number;
};

type EditorSource = {
	getText: () => string;
};

const sessions = new Map<string, TexLiveSession>();
const fileSessions = new Map<string, string>();
const editors = new Map<string, EditorSource>();
const indexes = new WeakMap<EditorView, ByteIndex>();
const queues = new Map<string, Promise<void>>();
const starting = new Map<string, Promise<TexLiveSession>>();
const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** StrictMode mounts/unmounts panes back to back; a close should not kill a
 * session that the next mount is about to reuse. */
const STOP_GRACE_MS = 1500;

function normalized(path: string): string {
	return normalizePathKey(path);
}

function isUnder(path: string, root: string): boolean {
	const child = normalizePathKey(path);
	const parent = normalizePathKey(root);
	return child === parent || child.startsWith(`${parent}/`);
}

function projectRelative(path: string, projectRoot: string): string | null {
	const child = normalizeSlashes(path);
	const parent = normalizeSlashes(projectRoot).replace(/\/+$/, "");
	if (!isUnder(child, parent)) return null;
	return child.slice(parent.length).replace(/^\/+/, "");
}

function enqueue(path: string, task: () => Promise<void>): void {
	const key = normalized(path);
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.then(task, task);
	queues.set(key, next);
	void next.finally(() => {
		if (queues.get(key) === next) queues.delete(key);
	});
}

function attachEditor(
	session: TexLiveSession,
	path: string,
	source: EditorSource,
): void {
	const rel = projectRelative(path, session.projectRoot);
	if (!rel) return;
	fileSessions.set(normalized(path), session.id);
	const text = source.getText();
	enqueue(path, async () => {
		await commands.rtexSetDocument(session.id, rel, text);
	});
}

function attachAllEditors(session: TexLiveSession): void {
	for (const [path, source] of editors) {
		if (isUnder(path, session.projectRoot)) attachEditor(session, path, source);
	}
}

function retain(session: TexLiveSession): TexLiveSession {
	const active = session.refs > 0;
	session.refs += 1;
	const timer = stopTimers.get(session.id);
	if (timer) {
		clearTimeout(timer);
		stopTimers.delete(session.id);
	}
	attachAllEditors(session);
	// A reused session already delivered its first layout to an earlier pane;
	// ask for a fresh one so this pane cannot sit on "waiting for first page".
	if (active) void commands.rtexRequestLayout(session.id);
	return session;
}

/** Start (or reuse) the rtex session for a project root. */
export async function startTexLiveSession(
	rootPath: string,
	vaultPath: string,
): Promise<TexLiveSession> {
	const key = normalized(rootPath);
	const existing = [...sessions.values()].find(
		(session) => normalized(session.rootPath) === key,
	);
	if (existing) return retain(existing);

	// StrictMode (and two quick clicks) would otherwise race two `rtex_start`
	// calls and let the unmounted caller stop the surviving session.
	let pending = starting.get(key);
	if (!pending) {
		pending = (async () => {
			const result = await commands.rtexStart(rootPath, vaultPath, true);
			if (!result.ok || !result.data) {
				throw new Error(result.error?.message ?? "cannot start rtex session");
			}
			const session: TexLiveSession = {
				id: result.data.sessionId,
				rootPath,
				projectRoot: result.data.projectRoot,
				mainFile: result.data.mainFile,
				refs: 0,
			};
			sessions.set(session.id, session);
			return session;
		})();
		starting.set(key, pending);
		void pending.finally(() => {
			if (starting.get(key) === pending) starting.delete(key);
		});
	}
	return retain(await pending);
}

async function finalizeStop(sessionId: string): Promise<void> {
	const session = sessions.get(sessionId);
	if (!session || session.refs > 0) return;
	sessions.delete(sessionId);
	for (const [path, id] of [...fileSessions]) {
		if (id === sessionId) fileSessions.delete(path);
	}
	await commands.rtexStop(sessionId);
}

/**
 * Release one pane's hold on a session. The actual `rtex_stop` is delayed so
 * a StrictMode remount (or a quick tab switch) can reuse the warm session.
 */
export async function stopTexLiveSession(sessionId: string): Promise<void> {
	const session = sessions.get(sessionId);
	if (!session) return;
	session.refs = Math.max(0, session.refs - 1);
	if (session.refs > 0 || stopTimers.has(sessionId)) return;
	const timer = setTimeout(() => {
		stopTimers.delete(sessionId);
		void finalizeStop(sessionId);
	}, STOP_GRACE_MS);
	stopTimers.set(sessionId, timer);
}

/**
 * Register a mounted CodeMirror editor. A session that already covers the file
 * receives its current buffer immediately; later sessions attach on start.
 */
export function registerTexLiveEditor(
	path: string,
	source: EditorSource,
): () => void {
	editors.set(normalized(path), source);
	for (const session of sessions.values()) {
		if (isUnder(path, session.projectRoot)) attachEditor(session, path, source);
	}
	return () => {
		if (editors.get(normalized(path)) === source) {
			editors.delete(normalized(path));
			fileSessions.delete(normalized(path));
		}
	};
}

/** Send a transaction's edits to rtex (reverse order keeps offsets valid). */
export function texLiveApplyUpdate(
	path: string,
	view: EditorView,
	update: ViewUpdate,
): void {
	if (!update.docChanged) return;
	const sessionId = fileSessions.get(normalized(path));
	if (!sessionId) return;
	const session = sessions.get(sessionId);
	if (!session) return;
	const rel = projectRelative(path, session.projectRoot);
	if (!rel) return;

	let index = indexes.get(view);
	if (!index) {
		index = new ByteIndex(update.startState.doc);
		indexes.set(view, index);
	}
	const edits = editsFromUpdate(update, index);
	if (edits.length === 0) return;

	enqueue(path, async () => {
		for (const edit of [...edits].reverse()) {
			const result = await commands.rtexEdit(
				session.id,
				rel,
				edit.start,
				edit.end,
				edit.text,
			);
			if (!result.ok) {
				// A file created after the session started is unknown to rtex;
				// seed the whole buffer once, then later keystrokes use edits.
				await commands.rtexSetDocument(
					session.id,
					rel,
					update.state.doc.toString(),
				);
				break;
			}
		}
	});

	index.update(update.state.doc, firstChangedLine(update));
}

/** Full-buffer sync for external reloads / editor focus changes. */
export function texLiveSetDocument(path: string, text: string): void {
	const sessionId = fileSessions.get(normalized(path));
	if (!sessionId) return;
	const session = sessions.get(sessionId);
	if (!session) return;
	const rel = projectRelative(path, session.projectRoot);
	if (!rel) return;
	enqueue(path, async () => {
		await commands.rtexSetDocument(session.id, rel, text);
	});
}

/** Whether a live session currently owns this project root. */
export function isTexLiveRootActive(rootPath: string): boolean {
	const key = normalized(rootPath);
	for (const session of sessions.values()) {
		if (normalized(session.rootPath) === key) return true;
	}
	return false;
}
