/**
 * Layout label colors from EmbedPDF `@embedpdf/plugin-layout-analysis`
 * LayoutAnalysisLayer (fill α≈0.15 / border α≈0.7).
 * Source: packages/plugin-layout-analysis react adapter FILL_COLORS / BORDER_COLORS.
 * `algorithm` is not in that map — use indigo (paragraph_title hue family).
 * Caption kinds use muted grey (not shown as sidebar cards).
 */

import type { PdfLayoutKind } from "@/lib/pdf/layout/types";

/** Solid hex for UI chrome (badges, borders) — matches border hue at full opacity. */
export const LAYOUT_KIND_HEX: Record<PdfLayoutKind, string> = {
	image: "#f59e0b",
	chart: "#f97316",
	table: "#10b981",
	algorithm: "#6366f1",
	formula: "#06b6d4",
	formula_number: "#0891b2",
	figure_title: "#6b7280",
	header: "#ec4899",
	abstract: "#a855f7",
	text: "#94a3b8",
};

/** Soft fill used for card tints / PDF focus overlays. */
export const LAYOUT_KIND_FILL: Record<PdfLayoutKind, string> = {
	image: "rgba(245, 158, 11, 0.05)",
	chart: "rgba(249, 115, 22, 0.05)",
	table: "rgba(16, 185, 129, 0.05)",
	algorithm: "rgba(99, 102, 241, 0.05)",
	formula: "rgba(6, 182, 212, 0.05)",
	formula_number: "rgba(8, 145, 178, 0.04)",
	figure_title: "rgba(107, 114, 128, 0.05)",
	header: "rgba(236, 72, 153, 0.05)",
	abstract: "rgba(168, 85, 247, 0.05)",
	text: "rgba(148, 163, 184, 0.03)",
};

/** Stronger border / ring (matches EmbedPDF overlay border). */
export const LAYOUT_KIND_BORDER: Record<PdfLayoutKind, string> = {
	image: "rgba(245, 158, 11, 0.4)",
	chart: "rgba(249, 115, 22, 0.4)",
	table: "rgba(16, 185, 129, 0.4)",
	algorithm: "rgba(99, 102, 241, 0.4)",
	formula: "rgba(6, 182, 212, 0.4)",
	formula_number: "rgba(8, 145, 178, 0.3)",
	figure_title: "rgba(107, 114, 128, 0.4)",
	header: "rgba(236, 72, 153, 0.4)",
	abstract: "rgba(168, 85, 247, 0.4)",
	text: "rgba(148, 163, 184, 0.2)",
};

export function layoutKindHex(kind: PdfLayoutKind): string {
	return LAYOUT_KIND_HEX[kind];
}

export function layoutKindFill(kind: PdfLayoutKind): string {
	return LAYOUT_KIND_FILL[kind];
}

export function layoutKindBorder(kind: PdfLayoutKind): string {
	return LAYOUT_KIND_BORDER[kind];
}
