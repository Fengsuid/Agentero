import { describe, expect, it, vi } from "vitest";
import {
	beginPdfNavigation,
	cancelPdfNavigation,
	cancelPdfNavigationForTab,
	completePdfNavigation,
	registerPdfNavigationOwner,
} from "@/lib/pdf/pending-pdf-page";

function requestPdfNavigation(key: string, target: { page: number }) {
	completePdfNavigation(beginPdfNavigation(key), target);
}

function owner(key: string) {
	const navigate = vi.fn(() => true);
	const restore = vi.fn(() => true);
	return {
		...registerPdfNavigationOwner(key, { navigate, restore }),
		navigate,
		restore,
	};
}

describe("PDF navigation ownership", () => {
	it("waits for actual layout readiness and consumes the region once", () => {
		const region = {
			id: "figure-1",
			pageIndex: 10,
			bbox: { x: 0.1, y: 0.2, w: 0.4, h: 0.3 },
		};
		completePdfNavigation(beginPdfNavigation("/vault/a"), { page: 11, region });
		const view = owner("/vault/a");
		expect(view.navigate).not.toHaveBeenCalled();
		view.layoutReady(20);
		view.layoutReady(20);
		expect(view.navigate).toHaveBeenCalledExactlyOnceWith({ page: 11, region });
		expect(view.restore).not.toHaveBeenCalled();
		view.dispose();
		const reopened = owner("/vault/a");
		reopened.layoutReady(20);
		expect(reopened.navigate).not.toHaveBeenCalled();
		expect(reopened.restore).toHaveBeenCalledOnce();
		reopened.dispose();
	});

	it("the latest citation wins even when the old resolution completes or cancels later", () => {
		const view = owner("papers/b");
		const a = beginPdfNavigation("papers/b");
		view.layoutReady(20);
		expect(view.restore).not.toHaveBeenCalled();
		const b = beginPdfNavigation("papers/b");
		completePdfNavigation(b, { page: 9 });
		completePdfNavigation(a, { page: 3 });
		cancelPdfNavigation(a);
		expect(view.navigate).toHaveBeenCalledExactlyOnceWith({ page: 9 });
		expect(view.restore).not.toHaveBeenCalled();
		view.dispose();
	});

	it("restores once without a citation and does not replay it after a user page request", () => {
		const view = owner("restore");
		view.layoutReady(20);
		view.request({ page: 7 });
		view.layoutReady(20);
		expect(view.restore).toHaveBeenCalledExactlyOnceWith(20);
		expect(view.navigate).toHaveBeenCalledExactlyOnceWith({ page: 7 });
		view.dispose();
	});

	it("cancels unresolved work on unmount without clearing a newer request", async () => {
		const view = owner("unmounted");
		const a = beginPdfNavigation("unmounted");
		view.dispose();
		const b = beginPdfNavigation("unmounted");
		await Promise.resolve();
		completePdfNavigation(a, { page: 2 });
		completePdfNavigation(b, { page: 8 });
		const next = owner("unmounted");
		next.layoutReady(10);
		expect(next.navigate).toHaveBeenCalledExactlyOnceWith({ page: 8 });
		next.dispose();
	});

	it("preserves loading intent across an immediate StrictMode owner replacement", async () => {
		const first = owner("strict");
		const intent = beginPdfNavigation("strict");
		first.dispose();
		const replacement = owner("strict");
		await Promise.resolve();
		completePdfNavigation(intent, { page: 4 });
		replacement.layoutReady(10);
		expect(replacement.navigate).toHaveBeenCalledExactlyOnceWith({ page: 4 });
		replacement.dispose();
	});

	it("normalizes path keys and restores after invalid or failed requests", () => {
		requestPdfNavigation("papers\\c\\", { page: Number.NaN });
		const view = owner("papers/c");
		view.layoutReady(10);
		expect(view.navigate).not.toHaveBeenCalled();
		expect(view.restore).toHaveBeenCalledOnce();
		view.dispose();
		const failed = beginPdfNavigation("failure");
		const next = owner("failure");
		next.layoutReady(10);
		cancelPdfNavigation(failed);
		expect(next.restore).toHaveBeenCalledOnce();
		next.dispose();
	});
});

it("routes citations to the canonical tab while split pane page navigation stays local", () => {
	const main = owner("/vault/paper");
	const split = owner("/vault/paper::pane-1");
	main.layoutReady(20);
	split.layoutReady(20);
	main.request({ page: 3 });
	expect(main.navigate).toHaveBeenLastCalledWith({ page: 3 });
	expect(split.navigate).not.toHaveBeenCalled();
	split.request({ page: 7 });
	requestPdfNavigation("/vault/paper", { page: 10 });
	expect(main.navigate).toHaveBeenLastCalledWith({ page: 10 });
	expect(split.navigate).toHaveBeenCalledExactlyOnceWith({ page: 7 });
	main.dispose();
	split.dispose();
});

it("retains a ready request until the navigation capability can accept it", () => {
	const navigate = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
	const restore = vi.fn(() => true);
	const view = registerPdfNavigationOwner("late-scope", { navigate, restore });
	requestPdfNavigation("late-scope", { page: 4 });
	view.layoutReady(10);
	view.layoutReady(10);
	view.layoutReady(10);
	expect(navigate).toHaveBeenCalledTimes(2);
	expect(restore).not.toHaveBeenCalled();
	view.dispose();
});

it("an old document owner cannot cancel the replacement's pending request", async () => {
	const old = owner("reloaded");
	const current = owner("reloaded");
	const intent = beginPdfNavigation("reloaded");
	old.dispose();
	await Promise.resolve();
	completePdfNavigation(intent, { page: 6 });
	current.layoutReady(10);
	expect(current.navigate).toHaveBeenCalledExactlyOnceWith({ page: 6 });
	current.dispose();
});

it("closing a cold tab cancels its intent before any viewer owner mounted", () => {
	const intent = beginPdfNavigation("cold-close");
	cancelPdfNavigationForTab("cold-close");
	completePdfNavigation(intent, { page: 8 });
	const reopened = owner("cold-close");
	reopened.layoutReady(10);
	expect(reopened.navigate).not.toHaveBeenCalled();
	expect(reopened.restore).toHaveBeenCalledOnce();
	reopened.dispose();
});
