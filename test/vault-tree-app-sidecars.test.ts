import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FsDirEntry } from "@/lib/core/bindings";

// A remote (SSH) vault tree is built renderer-side through `remoteList`, so the
// app-sidecar hiding rule lives in `lib/vault/tree.ts`. Fake the session with
// an in-memory directory map keyed by vault-relative path.
const { remoteDirs } = vi.hoisted(() => ({
	remoteDirs: new Map<string, FsDirEntry[]>(),
}));

vi.mock("@/lib/vault/remote/remote-vault", () => ({
	isRemoteVaultHandle: (path: string | null | undefined) =>
		!!path && path.startsWith("remote:"),
	remoteSessionIdFromHandle: (handle: string) =>
		handle.slice("remote:".length).trim() || null,
	remoteList: vi.fn(
		async (_sessionId: string, path = "") => remoteDirs.get(path) ?? [],
	),
}));

import { listVaultDirChildren, loadVaultTree } from "@/lib/vault/tree";

const entry = (name: string, path: string, isDir: boolean): FsDirEntry => ({
	name,
	path,
	isDir,
	isFile: !isDir,
});

const names = (nodes: { name: string }[]) => nodes.map((n) => n.name);

const child = (
	nodes: { name: string; children?: { name: string }[] }[],
	name: string,
) => nodes.find((n) => n.name === name);

beforeEach(() => {
	remoteDirs.clear();
	// A paper folder kept outside `papers/` (moved in / copied by the user):
	// the refs + layout sidecars are its only content.
	remoteDirs.set("", [
		entry("loose-paper", "loose-paper", true),
		entry("with-tex", "with-tex", true),
		entry("papers", "papers", true),
	]);
	remoteDirs.set("loose-paper", [entry("source", "loose-paper/source", true)]);
	remoteDirs.set("loose-paper/source", [
		entry("agentero-cite.json", "loose-paper/source/agentero-cite.json", false),
		entry("layout.json", "loose-paper/source/layout.json", false),
	]);
	// Same, but with real TeX beside the sidecars: the bucket stays and only
	// the sidecars are filtered out of its listing.
	remoteDirs.set("with-tex", [entry("source", "with-tex/source", true)]);
	remoteDirs.set("with-tex/source", [
		entry("main.tex", "with-tex/source/main.tex", false),
		entry("agentero-cite.json", "with-tex/source/agentero-cite.json", false),
	]);
	remoteDirs.set("papers", [
		entry("p1", "papers/p1", true),
		entry("p2", "papers/p2", true),
	]);
	// Paper unit with NOTES.md: `source/` stays a lazy shell.
	remoteDirs.set("papers/p1", [
		entry("NOTES.md", "papers/p1/NOTES.md", false),
		entry("source", "papers/p1/source", true),
	]);
	remoteDirs.set("papers/p1/source", [
		entry("agentero-cite.json", "papers/p1/source/agentero-cite.json", false),
	]);
	// Paper unit without NOTES.md: `source/` is its only marker, so it must
	// survive for the renderer's paper detection.
	remoteDirs.set("papers/p2", [
		entry("p2.pdf", "papers/p2/p2.pdf", false),
		entry("source", "papers/p2/source", true),
	]);
	remoteDirs.set("papers/p2/source", [
		entry("agentero-cite.json", "papers/p2/source/agentero-cite.json", false),
	]);
});

describe("remote vault tree hides the app's own source/ sidecars", () => {
	it("skips a sidecar-only source/ bucket outside paper units", async () => {
		const tree = await loadVaultTree("remote:s1");
		expect(names(tree)).toEqual(["loose-paper", "papers", "with-tex"]);
		expect(child(tree, "loose-paper")?.children ?? []).toEqual([]);
	});

	it("keeps a source/ bucket with real content and filters its sidecars", async () => {
		const tree = await loadVaultTree("remote:s1");
		expect(names(child(tree, "with-tex")?.children ?? [])).toEqual(["source"]);

		const children = await listVaultDirChildren(
			"remote:s1",
			"remote:s1/with-tex/source",
		);
		expect(names(children)).toEqual(["main.tex"]);
	});

	it("keeps source/ for paper units under papers/", async () => {
		const tree = await loadVaultTree("remote:s1");
		const papers = child(tree, "papers");
		const p1 = child(papers?.children ?? [], "p1");
		expect(names(p1?.children ?? [])).toEqual(["source", "NOTES.md"]);
		expect(child(p1?.children ?? [], "source")?.children).toEqual([]);

		// Without NOTES.md the `source/` dir is the only paper marker.
		const p2 = child(papers?.children ?? [], "p2");
		expect(names(p2?.children ?? [])).toEqual(["source", "p2.pdf"]);
	});
});
