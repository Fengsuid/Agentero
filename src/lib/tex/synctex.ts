import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { normalizePath } from "@/lib/core/path";
import { embedPdfDocumentId } from "@/lib/pdf/document-id";
import { texBuildOptions } from "@/lib/tex/config";
import { getTexEditorCursor } from "@/lib/tex/editor-navigation";
import {
	getLatexArtifacts,
	type SyncTexLocation,
	syncTexForward,
} from "@/lib/tex/host";
import { validSyncTexLocation } from "@/lib/tex/synctex-geometry";
import { openTab } from "@/lib/workspace/navigation";
import { updateTab, workspaceStore } from "@/lib/workspace/store";
import { tabIdForPath } from "@/lib/workspace/tabs";

type TexPdfPeer = {
	tabId?: string;
	documentId?: string;
	navigate(location: SyncTexLocation): void;
	isActive(): boolean;
};
const viewers = new Map<string, Set<TexPdfPeer>>();
const pending = new Map<
	string,
	{ location: SyncTexLocation; documentId?: string; tabId?: string }
>();
let forwardRequest = 0;

/** The peer is registered only after its current PDF revision has a page layout. */
export function registerTexPdfViewer(
	pdfPath: string,
	peer: TexPdfPeer,
): () => void {
	const key = normalizePath(pdfPath);
	const peers = viewers.get(key) ?? new Set<TexPdfPeer>();
	peers.add(peer);
	viewers.set(key, peers);
	const target = pending.get(key);
	if (
		target &&
		(!target.documentId || target.documentId === peer.documentId) &&
		(!target.tabId || target.tabId === peer.tabId)
	) {
		pending.delete(key);
		peer.navigate(target.location);
	}
	return () => {
		peers.delete(peer);
		if (peers.size === 0) viewers.delete(key);
	};
}

function deliver(
	pdfPath: string,
	location: SyncTexLocation,
	queue: boolean,
	documentId?: string,
	tabId?: string,
): void {
	const key = normalizePath(pdfPath);
	const peers = [...(viewers.get(key) ?? [])].filter(
		(peer) =>
			(!documentId || peer.documentId === documentId) &&
			(!tabId || peer.tabId === tabId),
	);
	const peer = peers.find((entry) => entry.isActive()) ?? peers.at(-1);
	if (peer) peer.navigate(location);
	else if (queue) {
		pending.set(key, { location, documentId, tabId });
		if (pending.size > 32)
			pending.delete(pending.keys().next().value as string);
	}
}

export async function syncTexToPdf(
	sourcePath: string,
	line: number,
	column = 1,
	options?: { activate?: boolean },
): Promise<void> {
	const request = ++forwardRequest;
	try {
		const { resolveTexRoot } = await import("@/lib/workspace/tex-compile");
		const root = await resolveTexRoot(sourcePath);
		const tabs = workspaceStore.getState().tabs;
		// An older output can remain open after outDir/jobname changes. The
		// current build configuration, rather than an open tab, owns the target.
		const pdfPath = (await getLatexArtifacts(root, texBuildOptions(root)))
			.pdfPath;
		const matches = await syncTexForward(pdfPath, sourcePath, line, column);
		if (request !== forwardRequest) return;
		const target = matches.find(validSyncTexLocation);
		if (!target) {
			if (options?.activate !== false) notifyError(i18n.t("latexPdf:noMatch"));
			return;
		}
		let targetTabId: string | undefined;
		let targetDocumentId: string | undefined;
		if (options?.activate !== false) {
			// A live preview can occupy this same tab without having loaded the
			// on-disk PDF. Load its compiled bytes before leaving live mode.
			const liveTab = tabs.find(
				(tab) =>
					tab.texLive && normalizePath(tab.path) === normalizePath(pdfPath),
			);
			if (liveTab && !liveTab.pdfBytes) {
				const { localFileToArrayBuffer } = await import("@/lib/paper");
				const bytes = await localFileToArrayBuffer(pdfPath);
				if (request !== forwardRequest) return;
				if (!bytes) throw new Error(i18n.t("latexPdf:syncFailed"));
				updateTab(liveTab.id, { pdfBytes: bytes, loaded: true });
			}
			const referencePanelId = tabs.find(
				(tab) => normalizePath(tab.path) === normalizePath(sourcePath),
			)?.id;
			openTab(pdfPath, {
				preferMode: "pdf",
				...(referencePanelId
					? { placement: { direction: "right", referencePanelId } }
					: {}),
			});
			targetTabId = tabIdForPath(pdfPath);
			updateTab(targetTabId, { texRoot: root, texLive: false });
			// openTab activates the canonical pane synchronously, while React
			// peers can still report the old clone's active state. Bind the jump
			// to that exact pane and its current buffer revision.
			const activatedTab = workspaceStore
				.getState()
				.tabs.find((tab) => tab.id === targetTabId);
			if (activatedTab?.pdfBytes) {
				targetDocumentId = embedPdfDocumentId(
					activatedTab.id,
					activatedTab.pdfBytes,
				);
			}
		}
		deliver(
			pdfPath,
			target,
			options?.activate !== false,
			targetDocumentId,
			targetTabId,
		);
	} catch (error) {
		if (request === forwardRequest && options?.activate !== false)
			notifyError(errorText(error) || i18n.t("latexPdf:syncFailed"));
	}
}

/** Quiet follow-up: never opens/activates a pane or reports errors for a background build. */
export async function syncTexAfterBuild(
	rootPath: string,
	pdfPath: string,
	enabled: boolean,
): Promise<void> {
	const preferredTab = () => {
		const state = workspaceStore.getState();
		const tabs = state.tabs.filter(
			(candidate) =>
				!candidate.texLive &&
				candidate.mode === "pdf" &&
				normalizePath(candidate.path) === normalizePath(pdfPath),
		);
		const activePeer = [...(viewers.get(normalizePath(pdfPath)) ?? [])].find(
			(peer) => peer.isActive(),
		);
		return (
			tabs.find((candidate) => candidate.id === state.activeTabId) ??
			tabs.find((candidate) => candidate.id === activePeer?.tabId) ??
			tabs.find((candidate) => candidate.id === tabIdForPath(pdfPath)) ??
			tabs[0]
		);
	};
	const tab = preferredTab();
	if (!enabled || (!viewers.has(normalizePath(pdfPath)) && !tab)) return;
	const cursor = getTexEditorCursor();
	if (!cursor) return;
	const request = forwardRequest;
	try {
		const { resolveTexRoot } = await import("@/lib/workspace/tex-compile");
		if (
			normalizePath(await resolveTexRoot(cursor.path)) !==
			normalizePath(rootPath)
		)
			return;
		const matches = await syncTexForward(
			pdfPath,
			cursor.path,
			cursor.line,
			cursor.column,
		);
		const target = matches.find(validSyncTexLocation);
		if (target && request === forwardRequest) {
			// Fresh bytes may already be in the store while React still owns
			// the old peer. Wait for this exact revision's page layout.
			const targetTab = preferredTab();
			const documentId = targetTab?.pdfBytes
				? embedPdfDocumentId(targetTab.id, targetTab.pdfBytes)
				: undefined;
			deliver(pdfPath, target, true, documentId, targetTab?.id);
		}
	} catch {
		/* Optional following must not turn a successful build into an error. */
	}
}
