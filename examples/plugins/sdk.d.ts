/** Agentero local plugin API v1. Runtime provides only this bridge, not DOM or Node. */
export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };
export interface PluginContext {
	kind: "command" | "activate" | "deactivate" | "event";
	windowId: string;
	/** Opaque, session-scoped grant identity; never a filesystem root. */
	vaultId: string;
	paperRef: string;
	locale: string;
	relPath: string | null;
	selectionText: string | null;
	event: string | null;
	payload: Json;
	settings: Record<string, string | boolean | number>;
}
export interface Paper {
	id: string;
	path: string;
	title: string;
	authors: string[];
	year: number | null;
	abstract: string | null;
	isRead: boolean;
	tags: Array<{ name: string; color?: string }>;
}
export interface TextSnapshot {
	path: string;
	content: string;
	revision: string;
}
export interface PluginError extends Error {
	code: string;
}
export interface Operations {
	"paper.get": [{ ref: string }, Paper];
	"paper.list": [
		{ query?: string; offset?: number; limit?: number },
		{ items: Paper[] },
	];
	"paper.set_read": [{ ref: string; isRead: boolean }, Paper];
	"paper.tag.list": [
		Record<string, never>,
		Array<{ name: string; count: number }>,
	];
	"paper.tag.add": [{ ref: string; tags: string[] }, Paper];
	"paper.tag.rm": [{ ref: string; tags: string[] }, Paper];
	"paper.tag.set": [{ ref: string; tags: string[] }, Paper];
	"paper.notes.get": [{ ref: string }, TextSnapshot];
	"paper.notes.write": [
		{
			ref: string;
			content: string;
			expectedRevision: string;
			mode?: "append" | "replace";
		},
		{ path: string; revision: string },
	];
	"file.read": [{ path: string }, TextSnapshot];
	"file.write": [
		{
			path: string;
			content: string;
			expectedRevision: string;
			mode?: "append" | "replace";
		},
		{ path: string; revision: string },
	];
	"file.list": [
		{ path?: string },
		{ entries: Array<{ path: string; name: string; isDirectory: boolean }> },
	];
	"vault.list": [Record<string, never>, Array<{ id: string; name: string }>];
	"vault.search": [{ query: string; limit?: number }, Json];
	"paper.paths": [{ ref: string }, { path: string; files: string[] }];
	"paper.move": [{ ref: string; destination: string }, Json];
	"layout.list": [{ ref: string }, Json];
	"layout.get": [{ ref: string; id: string }, Json];
	"page.read": [{ ref: string; page: number }, Json];
	"storage.get": [{ key: string }, Json];
	"storage.set": [{ key: string; value: Json }, null];
	"storage.delete": [{ key: string }, null];
}
declare global {
	const agentero: {
		call<K extends keyof Operations>(
			operation: K,
			args: Operations[K][0],
		): Promise<Operations[K][1]>;
	};
}
