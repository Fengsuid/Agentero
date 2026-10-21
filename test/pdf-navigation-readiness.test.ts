// @vitest-environment happy-dom
import { createBehaviorEmitter } from "@embedpdf/core";
import type {
	LayoutReadyEvent,
	ScrollCapability,
	ScrollScope,
} from "@embedpdf/plugin-scroll";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePdfNavigation } from "@/components/viewer/pdf/hooks/use-pdf-navigation";
import {
	beginPdfNavigation,
	completePdfNavigation,
} from "@/lib/pdf/pending-pdf-page";

const mocks = vi.hoisted(() => ({
	capability: null as unknown as ScrollCapability,
	read: vi.fn(() => 7),
	write: vi.fn(),
}));
vi.mock("@embedpdf/plugin-scroll/react", () => ({
	useScrollCapability: () => ({ provides: mocks.capability }),
}));
vi.mock("@/lib/pdf/reading-position", () => ({
	readReadingPage: mocks.read,
	writeReadingPage: mocks.write,
}));
vi.mock("@/lib/pdf/region-navigation", () => ({ scrollToPdfRegion: vi.fn() }));
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

it("uses replayed layout readiness and capability scope for a cold citation before reading restore", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const ready = createBehaviorEmitter<LayoutReadyEvent>();
	const scrollToPage = vi.fn();
	const scope = {
		scrollToPage,
		getMetrics: () => ({ currentPage: 1 }),
	} as unknown as ScrollScope;
	mocks.capability = {
		onLayoutReady: ready.on,
		forDocument: () => scope,
	} as unknown as ScrollCapability;
	const intent = beginPdfNavigation("cold-tab");
	completePdfNavigation(intent, { page: 12 });
	// The event is emitted before the hook subscribes, just like Scroller's
	// layout effect runs before the viewer's passive subscription effect.
	ready.emit({
		documentId: "cold-tab::r1",
		totalPages: 20,
		pageNumber: 1,
		isInitial: true,
	});
	function Viewer() {
		usePdfNavigation({
			docId: "cold-tab::r1",
			baseDocId: "cold-tab",
			paperKey: "paper",
			currentPage: 1,
			totalPages: 1,
			scroll: null,
			scrollRef: { current: null },
			docCapRef: { current: null },
		});
		return null;
	}
	const root = createRoot(document.createElement("div"));
	try {
		await act(() => root.render(createElement(Viewer)));
		expect(scrollToPage).toHaveBeenCalledExactlyOnceWith({
			pageNumber: 12,
			behavior: "instant",
		});
		expect(mocks.read).not.toHaveBeenCalled();
		await act(() =>
			ready.emit({
				documentId: "cold-tab::r1",
				totalPages: 20,
				pageNumber: 12,
				isInitial: false,
			}),
		);
		expect(scrollToPage).toHaveBeenCalledOnce();
	} finally {
		await act(() => root.unmount());
	}
});
