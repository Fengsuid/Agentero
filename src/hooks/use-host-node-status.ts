/**
 * Local-host Node.js / npm readiness for the Agent panes.
 *
 * One `doctor_check_host` probe on mount — never on every render or settings
 * switch. A successful one-click Node install broadcasts
 * `HOST_NODE_INSTALLED_EVENT` (see `lib/doctor/install-node`), so every pane
 * that mounted earlier re-probes and can rescan the Agent catalog; that keeps
 * the bundled-adapter badges and the Agent notice in sync no matter where the
 * install was started (Agent pane or Environment diagnostics).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { doctorCheckHost, type HostDoctorReport } from "@/lib/doctor/api";
import {
	HOST_NODE_INSTALLED_EVENT,
	installNodeInBackground,
} from "@/lib/doctor/install-node";

export type HostNodeStatus = {
	nodeMissing: boolean;
	npmMissing: boolean;
	/** True while the background Node install started here is running. */
	installing: boolean;
	/** Re-probe Node.js/npm (manual refresh or after an install elsewhere). */
	refresh: () => Promise<void>;
	/** One-click Node.js install + success/failure toast, then re-probe. */
	installNode: () => Promise<void>;
};

export function useHostNodeStatus(
	opts: {
		/** Runs after a successful install, e.g. to rescan the Agent catalog. */
		onInstalled?: () => void | Promise<void>;
	} = {},
): HostNodeStatus {
	const { onInstalled } = opts;
	const { t } = useTranslation("settings");
	const [report, setReport] = useState<HostDoctorReport | null>(null);
	const [installing, setInstalling] = useState(false);
	const checkedRef = useRef(false);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		try {
			setReport(await doctorCheckHost());
		} catch {
			// Environment diagnostics surfaces this failure in its own section;
			// the Agent pane stays quiet instead of adding a second error banner.
			setReport(null);
		}
	}, []);

	const handleInstalled = useCallback(async () => {
		await refresh();
		await onInstalled?.();
	}, [onInstalled, refresh]);

	useEffect(() => {
		const onHostNodeInstalled = () => void handleInstalled();
		window.addEventListener(HOST_NODE_INSTALLED_EVENT, onHostNodeInstalled);
		return () =>
			window.removeEventListener(
				HOST_NODE_INSTALLED_EVENT,
				onHostNodeInstalled,
			);
	}, [handleInstalled]);

	useEffect(() => {
		// Probe once per mount; remounts (e.g. a new settings window) re-check.
		if (checkedRef.current) return;
		checkedRef.current = true;
		void refresh();
	}, [refresh]);

	const installNode = useCallback(async () => {
		if (!isTauri() || installing) return;
		setInstalling(true);
		try {
			const result = await installNodeInBackground();
			// null = not desktop / already running / user cancelled: the task
			// panel row (or the other caller) owns that feedback.
			if (!result) return;
			if (result.outcome === "no-package-manager") {
				notifyError(t("doctor.host.install.noPackageManager"));
			} else if (result.error) {
				notifyError(result.error);
			} else {
				notifySuccess(t("doctor.host.install.success"));
				// The install module broadcast HOST_NODE_INSTALLED_EVENT; the
				// listener above re-probes and rescans for every mounted pane.
			}
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setInstalling(false);
		}
	}, [installing, t]);

	return {
		nodeMissing: report ? report.node.status !== "available" : false,
		npmMissing: report ? report.npm.status !== "available" : false,
		installing,
		refresh,
		installNode,
	};
}
