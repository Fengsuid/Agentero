/**
 * Rail layout controller: owns the resizable panel refs and the
 * imperative collapse / expand commands, and registers them into the
 * ui-store so plain actions (palette, shortcuts, agent) can drive layout.
 */

import { type RefObject, useEffect, useMemo, useRef } from "react";
import { usePanelRef } from "react-resizable-panels";
import {
	getShellLayoutPrefs,
	type RailLimits,
	railWidthsForSlot,
	seedBootWidths,
} from "@/lib/shell/layout-persist";
import {
	type LayoutPresetMode,
	layoutModeLeftCollapsed,
	layoutModeRightCollapsed,
	layoutModeRightRatio,
} from "@/lib/shell/layout-presets";
import {
	registerLayoutController,
	setLastAppliedPreset,
	setLayoutMode,
	setRightSidebarOpenState,
	setSidebarCollapsedState,
	uiStore,
} from "@/lib/shell/ui-store";
import { setNotesSplit, toggleNotesSplit } from "@/lib/workspace/actions";
import { getActiveTabId, getTabs } from "@/lib/workspace/store";
import { tabHasNotesSplit, tabNotesEligible } from "@/lib/workspace/tabs";

export const SIDEBAR_DEFAULT_PX = 200;
export const RIGHT_SIDEBAR_DEFAULT_PX = 320;
// Keep in sync with the Panel min/max constraints in App.tsx.
export const SIDEBAR_MIN_PX = 160;
export const SIDEBAR_MAX_RATIO = 0.3;
export const RIGHT_SIDEBAR_MIN_PX = 260;
export const RIGHT_SIDEBAR_MAX_RATIO = 0.5;
/** Collapse detection tolerance (collapsedSize is 0; sub-pixel rounding). */
export const RAIL_COLLAPSED_MAX_PX = 1;

const LEFT_LIMITS: RailLimits = {
	minPx: SIDEBAR_MIN_PX,
	maxRatio: SIDEBAR_MAX_RATIO,
};
const RIGHT_LIMITS: RailLimits = {
	minPx: RIGHT_SIDEBAR_MIN_PX,
	maxRatio: RIGHT_SIDEBAR_MAX_RATIO,
};

export type ShellLayout = {
	sidebarPanelRef: ReturnType<typeof usePanelRef>;
	rightSidebarPanelRef: ReturnType<typeof usePanelRef>;
	sourcePanelRef: ReturnType<typeof usePanelRef>;
	sidebarAsideRef: RefObject<HTMLElement | null>;
	editorPaneRef: RefObject<HTMLDivElement | null>;
	/** Last expanded rail widths in px (survive collapse / PDF immersive round-trips). */
	leftWidthPxRef: RefObject<number>;
	rightWidthPxRef: RefObject<number>;
	/** Restored boot widths (remembered ratios × current window, clamped). */
	initialLeftPx: number;
	initialRightPx: number;
};

/** Wait for the post-boot window restore/maximize animation to settle. */
const RAIL_BOOT_RESIZE_DEBOUNCE_MS = 150;
const RAIL_BOOT_RESIZE_LISTEN_MS = 2000;

export function useShellLayout(vaultPath: string | null = null): ShellLayout {
	const sidebarPanelRef = usePanelRef();
	const rightSidebarPanelRef = usePanelRef();
	const sourcePanelRef = usePanelRef();
	const sidebarAsideRef = useRef<HTMLElement>(null);
	const editorPaneRef = useRef<HTMLDivElement>(null);
	// Seed the left rail from its per-layout ratio and the Agent rail from its
	// global width so the first paint already matches the remembered
	// arrangement (see lib/shell/layout-persist.ts).
	const bootWidths = useMemo(
		() =>
			seedBootWidths(
				getShellLayoutPrefs(),
				window.innerWidth,
				LEFT_LIMITS,
				RIGHT_LIMITS,
				{ leftPx: SIDEBAR_DEFAULT_PX, rightPx: RIGHT_SIDEBAR_DEFAULT_PX },
			),
		[],
	);
	const leftWidthPxRef = useRef(bootWidths.leftPx);
	const rightWidthPxRef = useRef(bootWidths.rightPx);

	const controller = useMemo(() => {
		const rememberedWidths = () =>
			railWidthsForSlot(
				getShellLayoutPrefs(),
				uiStore.getState().lastAppliedPreset ?? "custom",
				window.innerWidth,
				LEFT_LIMITS,
				RIGHT_LIMITS,
			);

		/** Collapse / expand left file-tree panel without remounting. */
		const setLeftCollapsed = (collapsed: boolean) => {
			const panel = sidebarPanelRef.current;
			if (panel) {
				if (collapsed) {
					try {
						panel.collapse();
					} catch {
						// ignore
					}
				} else {
					const targetPx =
						rememberedWidths().leftPx ??
						(leftWidthPxRef.current || SIDEBAR_DEFAULT_PX);
					try {
						panel.expand();
						panel.resize(targetPx);
					} catch {
						// ignore
					}
					// expand() fires onResize synchronously and may overwrite the
					// remembered width with the library's default expand size.
					leftWidthPxRef.current = targetPx;
				}
			}
			setSidebarCollapsedState(collapsed);
		};

		/** Collapse / expand right Agent/Backlinks panel (always mounted). */
		const setRightCollapsed = (
			collapsed: boolean,
			_opts?: { focusAgent?: boolean },
		) => {
			const panel = rightSidebarPanelRef.current;
			if (panel) {
				if (collapsed) {
					try {
						panel.collapse();
					} catch {
						// ignore
					}
				} else {
					const targetPx =
						rememberedWidths().rightPx ??
						(rightWidthPxRef.current || RIGHT_SIDEBAR_DEFAULT_PX);
					try {
						panel.expand();
						panel.resize(targetPx);
					} catch {
						// ignore
					}
					rightWidthPxRef.current = targetPx;
				}
			}
			setRightSidebarOpenState(!collapsed);
		};

		/** Expand + resize the Agent rail to an absolute pixel width. */
		const setRightPx = (px: number) => {
			const panel = rightSidebarPanelRef.current;
			if (!panel) return;
			try {
				panel.expand();
				panel.resize(px);
			} catch {
				// ignore
			}
			rightWidthPxRef.current = px;
			setRightSidebarOpenState(true);
		};

		/** Resize the Agent rail as a fraction of the source + Agent area. */
		const setRightRatio = (ratio: number) => {
			const panel = rightSidebarPanelRef.current;
			const source = sourcePanelRef.current;
			if (!panel || !source) return;
			const total = source.getSize().inPixels + panel.getSize().inPixels;
			if (total <= 0) return;
			setRightPx(Math.round(total * ratio));
		};

		const applyLayoutMode = (mode: LayoutPresetMode) => {
			// Stop recording custom visibility before programmatic panel changes.
			setLayoutMode(mode);
			setLastAppliedPreset(mode);
			// Prefer the widths remembered for this mode; fall back to the
			// static preset ratios on first use.
			const saved = railWidthsForSlot(
				getShellLayoutPrefs(),
				mode,
				window.innerWidth,
				LEFT_LIMITS,
				RIGHT_LIMITS,
			);
			// Seed the remembered width before collapsing so a later manual
			// reopen (setLeftCollapsed(false) / setRightCollapsed(false))
			// restores this mode's width instead of the static default.
			const leftPx = saved.leftPx ?? SIDEBAR_DEFAULT_PX;
			const rightPx = saved.rightPx ?? RIGHT_SIDEBAR_DEFAULT_PX;
			leftWidthPxRef.current = leftPx;
			setLeftCollapsed(layoutModeLeftCollapsed(mode));

			if (mode === "notes") setNotesSplit(true, { preserveLayoutMode: true });
			else setNotesSplit(false, { preserveLayoutMode: true });

			if (layoutModeRightCollapsed(mode)) {
				setRightCollapsed(true);
				// Collapse can synchronously report the outgoing layout's width.
				rightWidthPxRef.current = rightPx;
			} else if (saved.rightPx !== undefined) {
				setRightPx(saved.rightPx);
			} else {
				setRightRatio(layoutModeRightRatio(mode));
			}
		};

		const focusSidebar = () => {
			// Expanding a collapsed rail deviates from the active preset.
			if (uiStore.getState().sidebarCollapsed) setLayoutMode("custom");
			setLeftCollapsed(false);
			requestAnimationFrame(() => {
				sidebarAsideRef.current?.querySelector<HTMLElement>("button")?.focus();
			});
		};

		const focusEditorPane = () => {
			editorPaneRef.current
				?.querySelector<HTMLElement>("[contenteditable='true']")
				?.focus();
		};

		const focusNotesEditor = () => {
			const tab = getTabs().find((t) => t.id === getActiveTabId());
			if (tab && tabNotesEligible(tab) && !tabHasNotesSplit(getTabs(), tab)) {
				toggleNotesSplit();
			}
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Prefer a NOTES secondary-pane editor when present.
					const root = editorPaneRef.current;
					if (!root) return;
					const editables = root.querySelectorAll<HTMLElement>(
						"[contenteditable='true']",
					);
					const target = editables[editables.length - 1] ?? editables[0];
					target?.focus();
				});
			});
		};

		return {
			setLeftCollapsed,
			setRightCollapsed,
			applyLayoutMode,
			focusSidebar,
			focusEditorPane,
			focusNotesEditor,
		};
	}, [sidebarPanelRef, rightSidebarPanelRef, sourcePanelRef]);

	useEffect(() => {
		registerLayoutController(controller);
		return () => registerLayoutController(null);
	}, [controller]);

	useEffect(() => {
		if (!vaultPath) return;
		// The left panel is conditional on the Vault. Its initial default and
		// the panel library's cached layout can predate the latest user resize.
		// Wait for panel registration, then restore from the current width slot.
		const frame = requestAnimationFrame(() => {
			const panel = sidebarPanelRef.current;
			if (!panel) return;
			const state = uiStore.getState();
			const saved = railWidthsForSlot(
				getShellLayoutPrefs(),
				state.lastAppliedPreset ?? "custom",
				window.innerWidth,
				LEFT_LIMITS,
				RIGHT_LIMITS,
			);
			const width = saved.leftPx ?? leftWidthPxRef.current;
			if (state.sidebarCollapsed) panel.collapse();
			else panel.resize(width);
			leftWidthPxRef.current = width;
		});
		return () => cancelAnimationFrame(frame);
	}, [vaultPath, sidebarPanelRef]);

	useEffect(() => {
		// macOS restores (and maximizes) the main window asynchronously: the
		// zoom animation can finish after React's first paint, so `bootWidths`
		// may have been seeded from the pre-restore viewport and
		// `preserve-pixel-size` then keeps that stale pixel width. Re-apply the
		// remembered ratios once the resize settles; outside this boot window
		// the rails keep their pixel widths when the window is resized.
		let settleTimer = 0;
		const applyRememberedWidths = () => {
			const state = uiStore.getState();
			const saved = railWidthsForSlot(
				getShellLayoutPrefs(),
				state.lastAppliedPreset ?? "custom",
				window.innerWidth,
				LEFT_LIMITS,
				RIGHT_LIMITS,
			);
			if (!state.sidebarCollapsed && saved.leftPx !== undefined) {
				sidebarPanelRef.current?.resize(saved.leftPx);
			}
			if (state.rightSidebarOpen && saved.rightPx !== undefined) {
				rightSidebarPanelRef.current?.resize(saved.rightPx);
			}
		};
		const onResize = () => {
			window.clearTimeout(settleTimer);
			settleTimer = window.setTimeout(
				applyRememberedWidths,
				RAIL_BOOT_RESIZE_DEBOUNCE_MS,
			);
		};
		const stopTimer = window.setTimeout(() => {
			window.removeEventListener("resize", onResize);
			window.clearTimeout(settleTimer);
		}, RAIL_BOOT_RESIZE_LISTEN_MS);
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("resize", onResize);
			window.clearTimeout(settleTimer);
			window.clearTimeout(stopTimer);
		};
	}, [sidebarPanelRef, rightSidebarPanelRef]);

	return {
		sidebarPanelRef,
		rightSidebarPanelRef,
		sourcePanelRef,
		sidebarAsideRef,
		editorPaneRef,
		leftWidthPxRef,
		rightWidthPxRef,
		initialLeftPx: bootWidths.leftPx,
		initialRightPx: bootWidths.rightPx,
	};
}
