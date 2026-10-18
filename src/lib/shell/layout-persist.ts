/**
 * Persisted shell rail widths (localStorage, best-effort).
 *
 * Widths are stored as fractions of the window width. The left Vault rail
 * keeps one entry per layout mode; the Agent/right rail uses a single global
 * `aiWidth` so opening it always returns the width the user last dragged,
 * regardless of the active layout preset. Follows the hand-rolled persist
 * modules (workspace tabs, paper info height): strict normalize on read,
 * silent best-effort writes, no store middleware.
 */

import {
	readJsonStorage,
	type StorageLike,
	writeJsonStorage,
} from "@/lib/core/storage";
import type { LayoutPresetMode } from "@/lib/shell/layout-presets";

export const SHELL_LAYOUT_STORAGE_KEY = "agentero.shellLayout.v1";

/** Rail width as a fraction of the window width (0.02–0.6, 3 decimals). */
export type RailWidthPrefs = {
	/** Left Vault rail width for this layout slot. */
	left?: number;
	/** Legacy per-slot Agent rail width; migrated into `aiWidth` on read. */
	right?: number;
};
export type LayoutWidthSlot = LayoutPresetMode | "custom";
/** Rail open/closed snapshot — only meaningful for the free-form custom mode. */
export type CustomRailsState = {
	leftCollapsed: boolean;
	rightOpen: boolean;
};
export type ShellLayoutPrefs = {
	lastMode: LayoutWidthSlot;
	/** Width owner survives manual changes (which switch lastMode to custom). */
	lastPreset?: LayoutPresetMode;
	/** Left Vault rail width, per layout slot. */
	widths: Partial<Record<LayoutWidthSlot, RailWidthPrefs>>;
	/** Agent/right rail width, shared by every layout slot. */
	aiWidth?: number;
	customRails?: CustomRailsState;
};

/** Sanity bounds for stored ratios (live panel caps are 30% / 50%). */
export const RAIL_RATIO_MIN = 0.02;
export const RAIL_RATIO_MAX = 0.6;
/** Matches the collapse-vs-resize recording threshold in App's onResize. */
export const RAIL_RECORD_MIN_PX = 80;

const SLOTS: readonly LayoutWidthSlot[] = [
	"agent",
	"notes",
	"reading",
	"custom",
];

export type RailLimits = {
	minPx: number;
	maxRatio: number;
};

export function normalizeRailRatio(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value < RAIL_RATIO_MIN || value > RAIL_RATIO_MAX) return null;
	return Math.round(value * 1000) / 1000;
}

/**
 * Older payloads kept a `right` width per layout slot. Seed the new global
 * width from the slot the user was last in, then custom, then any slot.
 */
function legacyAiWidth(
	rawWidths: Record<string, unknown>,
	lastMode: LayoutWidthSlot,
	lastPreset: LayoutPresetMode | undefined,
): number | null {
	const preferred = lastMode === "custom" ? (lastPreset ?? "custom") : lastMode;
	for (const slot of new Set<string>([preferred, "custom", ...SLOTS])) {
		const entry = rawWidths[slot];
		if (typeof entry !== "object" || entry === null) continue;
		const width = normalizeRailRatio((entry as Record<string, unknown>).right);
		if (width !== null) return width;
	}
	return null;
}

/** Self-heal any stored payload; never throws, unknown fields are dropped. */
export function normalizeShellLayoutPrefs(raw: unknown): ShellLayoutPrefs {
	const fallback: ShellLayoutPrefs = { lastMode: "custom", widths: {} };
	if (typeof raw !== "object" || raw === null) return fallback;
	const rec = raw as Record<string, unknown>;
	const lastMode = SLOTS.includes(rec.lastMode as LayoutWidthSlot)
		? (rec.lastMode as LayoutWidthSlot)
		: "custom";
	const lastPreset: LayoutPresetMode | undefined =
		rec.lastPreset === "agent" ||
		rec.lastPreset === "notes" ||
		rec.lastPreset === "reading"
			? rec.lastPreset
			: undefined;
	const rawWidths =
		typeof rec.widths === "object" && rec.widths !== null
			? (rec.widths as Record<string, unknown>)
			: {};
	const widths: Partial<Record<LayoutWidthSlot, RailWidthPrefs>> = {};
	for (const slot of SLOTS) {
		const entry = rawWidths[slot];
		if (typeof entry !== "object" || entry === null) continue;
		const left = normalizeRailRatio((entry as Record<string, unknown>).left);
		if (left !== null) widths[slot] = { left };
	}
	const prefs: ShellLayoutPrefs = { lastMode, widths };
	if (lastPreset !== undefined) prefs.lastPreset = lastPreset;
	const aiWidth =
		normalizeRailRatio(rec.aiWidth) ??
		legacyAiWidth(rawWidths, lastMode, lastPreset);
	if (aiWidth !== null) prefs.aiWidth = aiWidth;
	if (typeof rec.customRails === "object" && rec.customRails !== null) {
		const rails = rec.customRails as Record<string, unknown>;
		if (
			typeof rails.leftCollapsed === "boolean" &&
			typeof rails.rightOpen === "boolean"
		) {
			prefs.customRails = {
				leftCollapsed: rails.leftCollapsed,
				rightOpen: rails.rightOpen,
			};
		}
	}
	return prefs;
}

/** Ratio → px against the current viewport, clamped into the panel's limits. */
export function railPxFromRatio(
	ratio: number | undefined,
	viewportPx: number,
	limits: RailLimits,
): number | null {
	if (ratio === undefined) return null;
	const maxPx = Math.round(viewportPx * limits.maxRatio);
	if (maxPx < limits.minPx) return null; // degenerate narrow window
	return Math.round(
		Math.min(Math.max(ratio * viewportPx, limits.minPx), maxPx),
	);
}

/**
 * Restored px widths for one layout slot (undefined side = not remembered).
 * The right side is global; `slot` only selects the left rail preference.
 */
export function railWidthsForSlot(
	prefs: ShellLayoutPrefs,
	slot: LayoutWidthSlot,
	viewportPx: number,
	left: RailLimits,
	right: RailLimits,
): { leftPx?: number; rightPx?: number } {
	const out: { leftPx?: number; rightPx?: number } = {};
	const leftPx = railPxFromRatio(prefs.widths[slot]?.left, viewportPx, left);
	if (leftPx !== null) out.leftPx = leftPx;
	const rightPx = railPxFromRatio(prefs.aiWidth, viewportPx, right);
	if (rightPx !== null) out.rightPx = rightPx;
	return out;
}

/**
 * Boot seeding: for the left rail prefer the restored mode's slot, then the
 * custom slot, then the static default. The Agent rail is one global width.
 */
export function seedBootWidths(
	prefs: ShellLayoutPrefs,
	viewportPx: number,
	left: RailLimits,
	right: RailLimits,
	defaults: { leftPx: number; rightPx: number },
): { leftPx: number; rightPx: number } {
	const primary = railWidthsForSlot(
		prefs,
		prefs.lastMode === "custom"
			? (prefs.lastPreset ?? "custom")
			: prefs.lastMode,
		viewportPx,
		left,
		right,
	);
	const secondary = railWidthsForSlot(prefs, "custom", viewportPx, left, right);
	return {
		leftPx: primary.leftPx ?? secondary.leftPx ?? defaults.leftPx,
		rightPx: primary.rightPx ?? secondary.rightPx ?? defaults.rightPx,
	};
}

let cache: ShellLayoutPrefs | null = null;

/** Read + normalize; the default-storage read also refreshes the module cache. */
export function loadShellLayoutPrefs(
	storage?: StorageLike | null,
): ShellLayoutPrefs {
	const prefs = normalizeShellLayoutPrefs(
		readJsonStorage(SHELL_LAYOUT_STORAGE_KEY, null, storage),
	);
	if (storage === undefined) cache = prefs;
	return prefs;
}

export function getShellLayoutPrefs(): ShellLayoutPrefs {
	return cache ?? loadShellLayoutPrefs();
}

function persist(prefs: ShellLayoutPrefs, storage?: StorageLike | null): void {
	if (storage === undefined) cache = prefs;
	writeJsonStorage(SHELL_LAYOUT_STORAGE_KEY, prefs, storage);
}

function currentPrefs(storage?: StorageLike | null): ShellLayoutPrefs {
	return storage === undefined
		? getShellLayoutPrefs()
		: loadShellLayoutPrefs(storage);
}

/**
 * Record a completed user resize. Left widths stay per layout slot; the Agent
 * rail width is global. Sides whose px equivalent collapsed below
 * RAIL_RECORD_MIN_PX keep the previously remembered width (dragging a rail
 * shut must not poison it); ratios outside sanity bounds are dropped.
 */
export function commitShellRailWidths(
	widths: { leftRatio?: number; rightRatio?: number },
	slot: LayoutWidthSlot,
	viewportPx: number,
	storage?: StorageLike | null,
): void {
	const prefs = currentPrefs(storage);
	let changed = false;
	if (
		widths.leftRatio !== undefined &&
		widths.leftRatio * viewportPx >= RAIL_RECORD_MIN_PX
	) {
		const next = normalizeRailRatio(widths.leftRatio);
		if (next !== null && next !== prefs.widths[slot]?.left) {
			prefs.widths[slot] = { left: next };
			changed = true;
		}
	}
	if (
		widths.rightRatio !== undefined &&
		widths.rightRatio * viewportPx >= RAIL_RECORD_MIN_PX
	) {
		const next = normalizeRailRatio(widths.rightRatio);
		if (next !== null && next !== prefs.aiWidth) {
			prefs.aiWidth = next;
			changed = true;
		}
	}
	if (!changed) return;
	persist(prefs, storage);
}

/** Mirror the live layout mode so the next boot restores it. */
export function saveLastMode(
	mode: LayoutWidthSlot,
	storage?: StorageLike | null,
): void {
	const prefs = currentPrefs(storage);
	if (prefs.lastMode === mode) return;
	prefs.lastMode = mode;
	persist(prefs, storage);
}

export function saveLastPreset(mode: LayoutPresetMode): void {
	const prefs = getShellLayoutPrefs();
	if (prefs.lastPreset === mode) return;
	prefs.lastPreset = mode;
	persist(prefs);
}

/** Snapshot the free-form arrangement (custom mode only). */
export function saveCustomRails(
	state: CustomRailsState,
	storage?: StorageLike | null,
): void {
	const prefs = currentPrefs(storage);
	const prev = prefs.customRails;
	if (
		prev &&
		prev.leftCollapsed === state.leftCollapsed &&
		prev.rightOpen === state.rightOpen
	) {
		return;
	}
	prefs.customRails = state;
	persist(prefs, storage);
}
