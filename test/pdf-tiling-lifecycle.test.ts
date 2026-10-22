import { PdfErrorCode, type PdfErrorReason, Task } from "@embedpdf/models";
import { type Tile, TilingPlugin } from "@embedpdf/plugin-tiling";
import { expect, it, vi } from "vitest";

it("cancels both panes' unfinished renders without a shared-task wrapper", () => {
	const tasks: Task<Blob, PdfErrorReason>[] = [];
	const renderPageRect = vi.fn(() => {
		const task = new Task<Blob, PdfErrorReason>();
		vi.spyOn(task, "abort");
		tasks.push(task);
		return task;
	});
	const forDocument = vi.fn(() => ({ renderPageRect }));
	const plugin = {
		config: {},
		renderCapability: { forDocument },
		getCoreDocument: () => ({
			rotation: 0,
			document: { pages: [{ rotation: 1 }] },
		}),
		dispatch: vi.fn(),
	} as unknown as TilingPlugin;
	const rect = { origin: { x: 0, y: 0 }, size: { width: 200, height: 300 } };
	const tile: Tile = {
		id: "same-tile",
		col: 0,
		row: 0,
		pageRect: rect,
		screenRect: rect,
		srcScale: 1,
		status: "queued",
		isFallback: false,
	};
	const options = { pageIndex: 0, tile, dpr: 2 };
	const source = TilingPlugin.prototype.renderTile.call(
		plugin,
		options,
		"pdf::r1",
	);
	const translation = TilingPlugin.prototype.renderTile.call(
		plugin,
		options,
		"pdf::translation::r2",
	);
	expect(source).toBe(tasks[0]);
	expect(translation).toBe(tasks[1]);
	expect(forDocument.mock.calls).toEqual([
		["pdf::r1"],
		["pdf::translation::r2"],
	]);
	const reason = { code: PdfErrorCode.Cancelled, message: "left viewport" };
	source.abort(reason);
	translation.abort(reason);
	expect(tasks).toHaveLength(2);
	for (const task of tasks) expect(task.abort).toHaveBeenCalledOnce();
	expect(renderPageRect).toHaveBeenCalledWith({
		pageIndex: 0,
		rect,
		options: { scaleFactor: 1, dpr: 2, rotation: 1 },
	});
});
