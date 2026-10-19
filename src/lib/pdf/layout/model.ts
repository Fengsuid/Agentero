import { commands, type LayoutModelStatus } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { enqueueTask, enqueueTaskSettled } from "@/lib/core/tasks";
import { isTauri } from "@/lib/core/tauri";

/** Local custom-protocol URL for the XDG-cached ONNX (Host serves the file). */
export function layoutModelLocalUrl(fileName = "pp-doclayoutv3.onnx"): string {
	const origin = navigator.userAgent.includes("Windows")
		? "http://agentero-model.localhost"
		: "agentero-model://localhost";
	return `${origin}/${fileName}`;
}

export async function getLayoutModelStatus(): Promise<LayoutModelStatus | null> {
	if (!isTauri()) return null;
	return callApi(() => commands.layoutModelStatus());
}

function modelDownloadSpec() {
	return { kind: "modelDownload", vaultPath: "", path: "" } as const;
}

/**
 * Ensure PP-DocLayoutV3 is on disk under XDG cache.
 * If missing, joins / starts the Host `modelDownload` job: the JobCenter
 * fingerprint dedupes concurrent triggers (startup, analyze, prefetch) into
 * one download, whose progress projects into the background-tasks panel.
 */
export async function ensureLayoutModel(): Promise<LayoutModelStatus | null> {
	if (!isTauri()) return null;
	try {
		const existing = await getLayoutModelStatus();
		if (existing?.ready) return existing;
	} catch {
		// Fall through to the download job.
	}
	await enqueueTaskSettled(modelDownloadSpec());
	return getLayoutModelStatus();
}

/**
 * Kick the download job if the model is still missing (Host startup may have
 * enqueued it already — dedupe joins that job). Safe to call once from App
 * mount; progress / failure surface on the projected panel row.
 */
export function prefetchLayoutModel(): void {
	if (!isTauri()) return;
	void (async () => {
		try {
			const s = await getLayoutModelStatus();
			if (s?.ready) return;
			await enqueueTask(modelDownloadSpec());
		} catch (e) {
			logger.warn("layout model prefetch failed", { error: errorText(e) });
		}
	})();
}
