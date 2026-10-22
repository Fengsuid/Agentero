/**
 * Background runner for the one-click Node.js / npm install.
 *
 * Wraps the Doctor install command in a task-panel row so a multi-minute
 * winget / brew download never blocks the invoking UI. Progress comes from the
 * `agent-lifecycle:progress` event (same Host channel as Agent installs), and
 * cancel is routed to the same cooperative-cancel registry via
 * `agent_lifecycle_cancel`.
 */

import i18n from "@/i18n";
import {
	completeBackgroundTask,
	failBackgroundTask,
	getBackgroundTasksSnapshot,
	isBackgroundTaskCancelledError,
	registerBackgroundTaskCancelHandler,
	releaseBackgroundTaskCancelHandler,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";
import { commands, events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { isTauri } from "@/lib/core/tauri";
import { listenEventSafe } from "@/lib/core/tauri-events";
import { doctorInstallNode, type NodeInstallResult } from "@/lib/doctor/api";

/**
 * Broadcast after a successful install so panes that mounted earlier (Agent
 * settings notice, lifecycle guards) re-probe Node/npm and rescan the catalog
 * instead of keeping a stale "Node.js required" state.
 */
export const HOST_NODE_INSTALLED_EVENT = "agentero:host-node-installed";

function broadcastHostNodeInstalled(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(HOST_NODE_INSTALLED_EVENT));
}

/** True while a Node install row is already queued or running. */
function nodeInstallActive(): boolean {
	return getBackgroundTasksSnapshot().tasks.some(
		(task) =>
			task.kind === "nodeInstall" &&
			(task.status === "queued" || task.status === "running"),
	);
}

/**
 * Install Node.js (which bundles npm) as a task-panel row.
 *
 * Resolves with the Host result, or `null` when the environment is not desktop,
 * an install is already running, or the user cancelled. Callers own any
 * success / failure toast so the Doctor panel (which shows its own inline
 * notice) can stay silent.
 */
export async function installNodeInBackground(): Promise<NodeInstallResult | null> {
	if (!isTauri()) return null;
	if (nodeInstallActive()) return null;
	const taskId = `node-install-${Date.now().toString(36)}`;
	const rowId = startBackgroundTask({
		kind: "nodeInstall",
		title: i18n.t("settings:doctor.host.install.button"),
		detail: i18n.t("settings:doctor.host.install.installing"),
		icon: "download",
		progress: null,
	});
	registerBackgroundTaskCancelHandler(rowId, () => {
		void commands.agentLifecycleCancel(taskId).catch(() => {});
	});
	const stopProgress = listenEventSafe(
		events.agentLifecycleProgress,
		(payload) => {
			if (payload.taskId !== taskId) return;
			updateBackgroundTask(rowId, { progress: payload.progress });
		},
	);
	try {
		const result = await doctorInstallNode(taskId);
		if (result.outcome === "no-package-manager") {
			failBackgroundTask(
				rowId,
				i18n.t("settings:doctor.host.install.noPackageManager"),
			);
		} else if (result.error) {
			failBackgroundTask(rowId, result.error);
		} else {
			completeBackgroundTask(rowId);
			broadcastHostNodeInstalled();
		}
		return result;
	} catch (error) {
		if (isBackgroundTaskCancelledError(error)) return null;
		failBackgroundTask(rowId, errorText(error));
		// Let the caller surface the failure (inline notice / toast); the row
		// already shows the failed state in the task panel.
		throw error;
	} finally {
		stopProgress();
		releaseBackgroundTaskCancelHandler(rowId);
	}
}
