import { type PdfEngine, Task } from "@embedpdf/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ worker: vi.fn(), direct: vi.fn() }));
vi.mock("@embedpdf/engines/pdfium-worker-engine", () => ({
	createPdfiumEngine: mocks.worker,
}));
vi.mock("@embedpdf/engines/pdfium-direct-engine", () => ({
	createPdfiumEngine: mocks.direct,
}));
vi.mock("@/lib/pdf/system-font-fallback", () => ({
	loadSystemCjkFontFallback: async () => null,
}));
vi.mock("@/lib/core/logger", () => ({ logger: { warn: vi.fn() } }));

function engine() {
	const ready = new Task<boolean, unknown>();
	const closed = new Task<boolean, unknown>();
	closed.resolve(true);
	const value = {
		whenReady: () => ready,
		destroy: vi.fn(() => closed),
		closeAllDocuments: vi.fn(() => closed),
	};
	return { ready, value, pdf: value as unknown as PdfEngine };
}

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("PDF engine startup ownership", () => {
	it("destroys a timed-out worker without waiting for its handshake and ignores late readiness", async () => {
		const worker = engine();
		const direct = engine();
		mocks.worker.mockReturnValue(worker.pdf);
		mocks.direct.mockResolvedValue(direct.pdf);
		const { createPdfEngine } = await import("@/lib/pdf/engine");
		const pending = createPdfEngine();
		await vi.advanceTimersByTimeAsync(8000);
		expect(await pending).toBe(direct.pdf);
		expect(worker.value.destroy).toHaveBeenCalledOnce();
		expect(worker.value.closeAllDocuments).not.toHaveBeenCalled();
		worker.ready.resolve(true);
		await Promise.resolve();
		expect(await createPdfEngine()).toBe(direct.pdf);
		expect(mocks.worker).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts an in-flight probe without disabling workers for the next consumer", async () => {
		const worker = engine();
		mocks.worker.mockReturnValue(worker.pdf);
		const { createPdfEngine } = await import("@/lib/pdf/engine");
		const controller = new AbortController();
		const pending = createPdfEngine(controller.signal);
		const rejection = expect(pending).rejects.toMatchObject({
			name: "AbortError",
		});
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await rejection;
		expect(worker.value.destroy).toHaveBeenCalledOnce();
		expect(mocks.direct).not.toHaveBeenCalled();
		const next = engine();
		next.ready.resolve(true);
		mocks.worker.mockReturnValue(next.pdf);
		expect(await createPdfEngine()).toBe(next.pdf);
		expect(mocks.worker).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("disposes a direct engine that finishes after its consumer unmounts", async () => {
		const worker = engine();
		worker.ready.reject(new Error("wasmError"));
		mocks.worker.mockReturnValue(worker.pdf);
		let finish!: (engine: PdfEngine) => void;
		mocks.direct.mockReturnValue(
			new Promise<PdfEngine>((resolve) => {
				finish = resolve;
			}),
		);
		const { createPdfEngine } = await import("@/lib/pdf/engine");
		const controller = new AbortController();
		const pending = createPdfEngine(controller.signal);
		const rejection = expect(pending).rejects.toMatchObject({
			name: "AbortError",
		});
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		const direct = engine();
		finish(direct.pdf);
		await rejection;
		expect(direct.value.destroy).toHaveBeenCalledOnce();
		expect(worker.value.destroy).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
