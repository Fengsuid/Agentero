/**
 * Page navigation and reading position.
 *
 * Grouped because they are one user-visible behaviour: the page field, jumping
 * to a page, and the "reopen where I left off" pair (restore once the document
 * reports its page count, then persist debounced as the user scrolls). The
 * restore must run exactly once per document, which is why it owns
 * `restoredRef` rather than reading it from the shell.
 */

import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import {
	type useScroll,
	useScrollCapability,
} from "@embedpdf/plugin-scroll/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
	type PdfNavigationRegion,
	registerPdfNavigationOwner,
} from "@/lib/pdf/pending-pdf-page";
import { readReadingPage, writeReadingPage } from "@/lib/pdf/reading-position";
import { scrollToPdfRegion } from "@/lib/pdf/region-navigation";

/** Debounce for persisting the last read page while scrolling. */
const READING_POSITION_SAVE_MS = 400;

type ScrollCapability = ReturnType<typeof useScroll>["provides"];

export type UsePdfNavigationOptions = {
	docId: string;
	/** Stable workspace tab id; distinct from split/translation panes. */
	baseDocId: string;
	docCapRef: RefObject<
		ReturnType<typeof useDocumentManagerCapability>["provides"]
	>;
	/** Stable per-paper key for the stored reading position (null = no memory). */
	paperKey: string | null;
	currentPage: number;
	totalPages: number;
	scroll: ScrollCapability;
	/** Capability ref: the restore effect must not depend on a fresh scope. */
	scrollRef: RefObject<ScrollCapability>;
};

export type PdfNavigation = {
	/** Toolbar input value (page text, not a number). */
	pageField: string;
	setPageField: (value: string) => void;
	/** True while the input has focus; blocks the observed-page sync. */
	pageFocusedRef: RefObject<boolean>;
	/** Clamp and jump; also the outline / citation jump target. */
	goToPage: (page: number) => void;
	goToRegion: (region: PdfNavigationRegion) => void;
	/** Apply the typed page (falls back to the current page). */
	commitPageField: () => void;
};

export function usePdfNavigation({
	docId,
	baseDocId,
	docCapRef,
	paperKey,
	currentPage,
	totalPages,
	scroll,
	scrollRef,
}: UsePdfNavigationOptions): PdfNavigation {
	const [pageField, setPageField] = useState("1");
	const pageFocusedRef = useRef(false);
	const restoredRef = useRef(false);
	const { provides: scrollCapability } = useScrollCapability();
	const ownerRef = useRef<ReturnType<typeof registerPdfNavigationOwner> | null>(
		null,
	);

	// Keep the page-number input in sync with the observed current page.
	useEffect(() => {
		if (!pageFocusedRef.current) setPageField(String(currentPage));
	}, [currentPage]);

	useEffect(() => {
		if (!scrollCapability) return;
		restoredRef.current = false;
		const owner = registerPdfNavigationOwner(baseDocId, {
			navigate: (target) => {
				const scope = scrollRef.current ?? scrollCapability.forDocument(docId);
				if (!scope) return false;
				restoredRef.current = true;
				if (target.region) {
					scrollToPdfRegion(
						docId,
						target.region,
						docCapRef.current?.getDocument(docId),
						scope,
					);
				} else {
					scope.scrollToPage({ pageNumber: target.page, behavior: "instant" });
				}
				return true;
			},
			restore: (pages) => {
				const scope = scrollRef.current ?? scrollCapability.forDocument(docId);
				if (!scope) return false;
				restoredRef.current = true;
				if (!paperKey || scope.getMetrics().currentPage > 1) return true;
				const saved = readReadingPage(paperKey);
				if (saved && saved > 1 && saved <= pages) {
					scope.scrollToPage({ pageNumber: saved, behavior: "instant" });
				}
				return true;
			},
		});
		ownerRef.current = owner;
		// EmbedPDF replays layout-ready to late subscribers; capability existence
		// and the provisional page count do not imply that the scroller is mounted.
		const off = scrollCapability.onLayoutReady((event) => {
			if (event.documentId === docId) owner.layoutReady(event.totalPages);
		});
		return () => {
			off();
			owner.dispose();
			if (ownerRef.current === owner) ownerRef.current = null;
		};
	}, [docId, baseDocId, paperKey, scrollCapability, scrollRef, docCapRef]);

	// Persist the last read page (debounced) as the user scrolls.
	useEffect(() => {
		if (!paperKey || !restoredRef.current || currentPage < 1) return;
		const id = setTimeout(() => {
			writeReadingPage(paperKey, currentPage);
		}, READING_POSITION_SAVE_MS);
		return () => clearTimeout(id);
	}, [paperKey, currentPage]);

	const goToPage = (n: number) => {
		if (!scroll || totalPages <= 0) return;
		const clamped = Math.min(totalPages, Math.max(1, Math.floor(n)));
		ownerRef.current?.request({ page: clamped });
	};

	const commitPageField = () => {
		const n = Number.parseInt(pageField, 10);
		if (Number.isFinite(n)) goToPage(n);
		else setPageField(String(currentPage));
	};

	return {
		pageField,
		setPageField,
		pageFocusedRef,
		goToPage,
		goToRegion: (region) =>
			ownerRef.current?.request({ page: region.pageIndex + 1, region }),
		commitPageField,
	};
}
