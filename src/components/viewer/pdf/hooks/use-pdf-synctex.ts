import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { type RefObject, useEffect, useRef } from "react";
import { EMBED_PAGE_ATTR } from "@/components/viewer/pdf/coords";
import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import type { PdfNavigationRegion } from "@/lib/pdf/pending-pdf-page";
import { navigateTexSource } from "@/lib/tex/editor-navigation";
import { syncTexBackward } from "@/lib/tex/host";
import { registerTexPdfViewer } from "@/lib/tex/synctex";
import {
	syncTexClickPoint,
	syncTexHighlightBox,
} from "@/lib/tex/synctex-geometry";

export function usePdfSyncTex(options: {
	docId: string;
	tabId: string;
	pdfPath?: string | null;
	rootPath?: string | null;
	isActive: boolean;
	hostRef: RefObject<HTMLDivElement | null>;
	navigate(region: PdfNavigationRegion): void;
	docCapRef: RefObject<
		ReturnType<typeof useDocumentManagerCapability>["provides"]
	>;
}): void {
	const latest = useRef(options);
	latest.current = options;
	const { provides: scrollCapability } = useScrollCapability();
	const { docId, pdfPath, rootPath, hostRef } = options;
	useEffect(() => {
		if (!pdfPath || !rootPath || !scrollCapability) return;
		let unregister: (() => void) | undefined;
		const off = scrollCapability.onLayoutReady((event) => {
			if (event.documentId !== docId || unregister) return;
			unregister = registerTexPdfViewer(pdfPath, {
				tabId: latest.current.tabId,
				documentId: docId,
				isActive: () => latest.current.isActive,
				navigate: (location) => {
					const { navigate, docCapRef } = latest.current;
					const size =
						docCapRef.current?.getDocument(docId)?.pages[location.page - 1]
							?.size;
					if (!size) return;
					navigate({
						id: `synctex:${location.page}:${location.x}:${location.y}`,
						pageIndex: location.page - 1,
						bbox: syncTexHighlightBox(location, size),
						kind: "text",
					});
				},
			});
		});
		return () => {
			off();
			unregister?.();
		};
	}, [docId, pdfPath, rootPath, scrollCapability]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host || !pdfPath || !rootPath) return;
		let navigation = 0;
		const click = (event: MouseEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return;
			const element =
				event.target instanceof Element
					? event.target.closest<HTMLElement>(`[${EMBED_PAGE_ATTR}]`)
					: null;
			if (!element || !host.contains(element)) return;
			const index = Number(element.getAttribute(EMBED_PAGE_ATTR));
			const state = latest.current.docCapRef.current?.getDocumentState(docId);
			const page = state?.document?.pages[index];
			if (!page) return;
			const point = syncTexClickPoint(
				{ x: event.clientX, y: event.clientY },
				element.getBoundingClientRect(),
				page.size,
				(page.rotation + (state?.rotation ?? 0)) % 4,
			);
			if (!point) return;
			event.preventDefault();
			event.stopPropagation();
			const request = ++navigation;
			void syncTexBackward(pdfPath, index + 1, point.x, point.y)
				.then((source) => {
					if (request !== navigation) return;
					if (source)
						navigateTexSource(source.path, source.line, source.column);
					else notifyError(i18n.t("latexPdf:noMatch"));
				})
				.catch((error) => {
					if (request === navigation)
						notifyError(errorText(error) || i18n.t("latexPdf:syncFailed"));
				});
		};
		host.addEventListener("click", click, true);
		return () => {
			navigation += 1;
			host.removeEventListener("click", click, true);
		};
	}, [docId, pdfPath, rootPath, hostRef]);
}
