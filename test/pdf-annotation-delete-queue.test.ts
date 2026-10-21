import { createRequire } from "node:module";
import {
	AnnotationPluginPackage,
	type AnnotationScope,
	initialDocumentState,
	initialState,
} from "@embedpdf/plugin-annotation";
import { describe, expect, it, vi } from "vitest";
import { createAnnotationDeleteQueue } from "@/lib/pdf/highlight/delete-queue";

function harness() {
	const id = "highlight";
	let state = initialState({});
	const document = initialDocumentState();
	document.byUid[id] = {
		commitState: "new",
		object: { id, pageIndex: 0 } as never,
	};
	document.pages[0] = [id];
	document.hasPendingChanges = true;
	state.documents.doc = document;
	let onState: () => void = () => {};
	const dispatch = (
		action: Parameters<NonNullable<typeof AnnotationPluginPackage.reducer>>[1],
	) => {
		const reduce = AnnotationPluginPackage.reducer;
		if (!reduce) throw new Error("Annotation reducer unavailable");
		state = reduce(state, action);
		onState();
	};
	const remove = vi.fn((pageIndex: number, annotationId: string) => {
		dispatch({
			type: "ANNOTATION/DELETE_ANNOTATION",
			payload: { documentId: "doc", pageIndex, id: annotationId },
		});
	});
	const off = vi.fn();
	const scope = {
		getState: () => state.documents.doc,
		deleteAnnotation: remove,
		onStateChange: (fn: () => void) => {
			onState = fn;
			return off;
		},
	} as Pick<AnnotationScope, "getState" | "deleteAnnotation" | "onStateChange">;
	const onError = vi.fn();
	const queue = createAnnotationDeleteQueue(scope, onError);
	return {
		queue,
		remove,
		off,
		onError,
		state: () => state.documents.doc,
		undo: () => {
			dispatch({
				type: "ANNOTATION/CREATE_ANNOTATION",
				payload: {
					documentId: "doc",
					pageIndex: 0,
					annotation: document.byUid[id].object,
				},
			});
		},
		commit: () => {
			dispatch({
				type: "ANNOTATION/COMMIT",
				payload: { documentId: "doc", committedUids: [id] },
			});
		},
	};
}

describe("annotation deletion coordinates with the same uid's commit", () => {
	it("keeps immediate deletion and reasserts it when the older commit settles even without a success event", async () => {
		const h = harness();
		h.queue.delete(0, "highlight");
		h.queue.delete(0, "highlight");
		await Promise.resolve();
		expect(h.remove).toHaveBeenCalledOnce();
		expect(h.state().byUid.highlight.commitState).toBe("deleted");
		h.commit();
		// Upstream clears the pending flag for the uid in the older batch.
		expect(h.state().hasPendingChanges).toBe(false);
		expect(h.remove).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect(h.remove).toHaveBeenCalledTimes(2);
		expect(h.state().byUid.highlight.commitState).toBe("deleted");
		expect(h.state().hasPendingChanges).toBe(true);
		h.queue.dispose();
	});

	it("does not replay after unmount (the immediate draft remains deleted)", async () => {
		const h = harness();
		h.queue.delete(0, "highlight");
		h.queue.dispose();
		h.commit();
		await Promise.resolve();
		expect(h.remove).toHaveBeenCalledOnce();
		expect(h.off).toHaveBeenCalledOnce();
	});
});

it("does not replay over undo and accepts a subsequent explicit deletion", async () => {
	const h = harness();
	h.queue.delete(0, "highlight");
	h.undo();
	h.commit();
	await Promise.resolve();
	expect(h.remove).toHaveBeenCalledOnce();
	h.queue.delete(0, "highlight");
	expect(h.remove).toHaveBeenCalledTimes(2);
	h.queue.dispose();
});

it("reports a failed deletion settlement once, stops replaying, and allows explicit retry", async () => {
	const h = harness();
	h.queue.delete(0, "highlight");
	h.commit();
	await Promise.resolve();
	expect(h.remove).toHaveBeenCalledTimes(2);
	// A rejected engine deletion emits no committed event and does not purge
	// the uid, but upstream still dispatches COMMIT after Task.allSettled.
	h.commit();
	await Promise.resolve();
	expect(h.onError).toHaveBeenCalledOnce();
	h.commit();
	await Promise.resolve();
	expect(h.remove).toHaveBeenCalledTimes(2);
	expect(h.onError).toHaveBeenCalledOnce();
	h.queue.delete(0, "highlight");
	expect(h.remove).toHaveBeenCalledTimes(3);
	h.queue.dispose();
});

it.each([
	"import",
	"require",
])("%s: recovers after a rejected update and settles a rejected delete without looping", async (mode) => {
	const load =
		mode === "import"
			? (name: string) => import(name)
			: async (name: string) => createRequire(import.meta.url)(name);
	const { PluginRegistry, startLoadingDocument, setDocumentLoaded } =
		await load("@embedpdf/core");
	const { PdfAnnotationSubtype, PdfTaskHelper, Task } =
		await load("@embedpdf/models");
	const { AnnotationPlugin, AnnotationPluginPackage } = await load(
		"@embedpdf/plugin-annotation",
	);
	const { InteractionManagerPluginPackage } = await load(
		"@embedpdf/plugin-interaction-manager",
	);
	const { SelectionPluginPackage } = await load("@embedpdf/plugin-selection");
	const update = new Task();
	const deletion = new Task();
	const annotation = {
		id: "live",
		type: PdfAnnotationSubtype.HIGHLIGHT,
		pageIndex: 0,
		rect: { origin: { x: 10, y: 10 }, size: { width: 20, height: 10 } },
	};
	const engine = {
		getAllAnnotations: () => PdfTaskHelper.resolve({ 0: [annotation] }),
		updatePageAnnotation: vi.fn(() => update),
		removePageAnnotation: vi.fn(() => deletion),
	};
	const registry = new PluginRegistry(
		engine as unknown as import("@embedpdf/models").PdfEngine,
	);
	registry.registerPlugin(InteractionManagerPluginPackage);
	registry.registerPlugin(SelectionPluginPackage);
	registry.registerPlugin(AnnotationPluginPackage);
	let queue: ReturnType<typeof createAnnotationDeleteQueue> | undefined;
	try {
		await registry.initialize();
		const store = registry.getStore();
		store.dispatchToCore(startLoadingDocument("doc"));
		store.dispatchToCore(
			setDocumentLoaded("doc", {
				id: "doc",
				pageCount: 1,
				pages: [{ index: 0, size: { width: 600, height: 800 } }],
			} as import("@embedpdf/models").PdfDocumentObject),
		);
		const plugin = registry.getPlugin<
			import("@embedpdf/plugin-annotation").AnnotationPlugin
		>(AnnotationPlugin.id);
		if (!plugin) throw new Error("Annotation plugin missing");
		const scope = plugin.provides().forDocument("doc");
		const onError = vi.fn();
		queue = createAnnotationDeleteQueue(scope, onError);
		scope.updateAnnotation(0, "live", { strokeColor: "#ff0000" });
		expect(engine.updatePageAnnotation).toHaveBeenCalledOnce();
		queue.delete(0, "live");
		expect(engine.removePageAnnotation).not.toHaveBeenCalled();
		update.reject(new Error("update failed"));
		await Promise.resolve();
		expect(engine.removePageAnnotation).toHaveBeenCalledOnce();
		deletion.reject(new Error("delete failed"));
		await Promise.resolve();
		expect(onError).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect(engine.removePageAnnotation).toHaveBeenCalledOnce();
	} finally {
		queue?.dispose();
		await registry.destroy();
	}
});
