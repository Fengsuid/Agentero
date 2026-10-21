// @vitest-environment happy-dom
import { PDFContext, type PDFContextState } from "@embedpdf/core/react";
import { Scroller, type ScrollerLayout } from "@embedpdf/plugin-scroll/react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocked = {
	emit: null as ((layout: ScrollerLayout) => void) | null,
	plugin: {
		onScrollerData: (
			_id: string,
			callback: (layout: ScrollerLayout) => void,
		) => {
			mocked.emit = callback;
			return () => {
				mocked.emit = null;
			};
		},
		ready: () => Promise.resolve(),
		setLayoutReady: vi.fn(),
		clearLayoutReady: vi.fn(),
	},
};

function layout(pageIndex: number): ScrollerLayout {
	return {
		startSpacing: pageIndex * 800,
		endSpacing: 4000 - pageIndex * 800,
		totalWidth: 600,
		totalHeight: 4800,
		pageGap: 8,
		strategy: "vertical",
		items: [
			{
				pageNumbers: [pageIndex + 1],
				pageLayouts: [
					{
						pageIndex,
						pageNumber: pageIndex + 1,
						width: 600,
						height: 800,
						rotatedWidth: 600,
						rotatedHeight: 800,
					},
				],
			},
		],
	} as ScrollerLayout;
}

it("the patched Scroller skips equal windows and renders page or geometry changes without an app global", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	const root = createRoot(container);
	const renderPage = vi.fn(({ pageIndex }: { pageIndex: number }) =>
		createElement("span", null, String(pageIndex)),
	);
	try {
		const value = {
			registry: { getPlugin: () => mocked.plugin },
			pluginsReady: true,
		} as unknown as PDFContextState;
		await act(() =>
			root.render(
				createElement(
					PDFContext.Provider,
					{ value },
					createElement(Scroller, { documentId: "doc", renderPage }),
				),
			),
		);
		await act(() => mocked.emit?.(layout(0)));
		const firstRenderCount = renderPage.mock.calls.length;
		await act(() => mocked.emit?.(layout(0)));
		expect(renderPage).toHaveBeenCalledTimes(firstRenderCount);
		await act(() => mocked.emit?.(layout(1)));
		expect(container.textContent).toBe("1");
		const rotated = layout(1);
		rotated.items[0].pageLayouts[0].rotatedWidth = 800;
		rotated.items[0].pageLayouts[0].rotatedHeight = 600;
		await act(() => mocked.emit?.(rotated));
		expect(renderPage.mock.lastCall?.[0]).toMatchObject({
			rotatedWidth: 800,
			rotatedHeight: 600,
		});
	} finally {
		await act(() => root.unmount());
		vi.unstubAllGlobals();
	}
});
