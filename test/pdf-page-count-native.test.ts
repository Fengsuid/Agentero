import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createPdfiumEngine } from "@embedpdf/engines/pdfium-direct-engine";
import { PDFDocument } from "pdf-lib";
import { expect, it, vi } from "vitest";
import { getPdfPageCount } from "@/lib/pdf/page-count";

const mocks = vi.hoisted(() => ({ read: vi.fn(), engine: vi.fn() }));
vi.mock("@/lib/paper", () => ({
	findLocalPdfPath: async () => "/smoke/a.pdf",
	localFileToArrayBuffer: mocks.read,
}));
vi.mock("@/lib/pdf/layout/headless-analyze", () => ({
	getHeadlessPdfEngine: mocks.engine,
}));

it("balances native document and tracked WASM allocations with the real PDFium engine", async () => {
	const require = createRequire(import.meta.url);
	const wasm = await readFile(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
	const engine = await createPdfiumEngine(
		`data:application/wasm;base64,${wasm.toString("base64")}`,
		{ fontFallback: null },
	);
	mocks.engine.mockResolvedValue(engine);
	const pdf = await PDFDocument.create();
	for (let i = 0; i < 3; i++) pdf.addPage();
	const bytes = await pdf.save();
	mocks.read.mockImplementation(async () => bytes.slice().buffer);
	// SDK-private counters are used only here to verify live native ownership;
	// WASM heap capacity need not shrink after a document is released.
	const native = (
		engine as unknown as {
			executor: {
				cache: { docs: Map<string, unknown> };
				memoryManager: {
					getStats(): { totalAllocated: number; allocationCount: number };
				};
			};
		}
	).executor;
	const stats = () => {
		const { totalAllocated, allocationCount } = native.memoryManager.getStats();
		return { docs: native.cache.docs.size, totalAllocated, allocationCount };
	};
	const open = vi.spyOn(engine, "openDocumentBuffer");
	const close = vi.spyOn(engine, "closeDocument");
	const baseline = stats();
	try {
		expect(baseline).toEqual({
			docs: 0,
			totalAllocated: 0,
			allocationCount: 0,
		});
		for (let i = 0; i < 32; i++) {
			expect(await getPdfPageCount("/smoke")).toBe(3);
			expect(stats()).toEqual(baseline);
		}
		expect(
			await Promise.all(
				Array.from({ length: 8 }, () => getPdfPageCount("/smoke")),
			),
		).toEqual(Array(8).fill(3));
		expect(stats()).toEqual(baseline);
		mocks.read.mockResolvedValueOnce(new ArrayBuffer(20));
		expect(await getPdfPageCount("/smoke")).toBeNull();
		expect(stats()).toEqual(baseline);
		expect(open).toHaveBeenCalledTimes(41);
		expect(close).toHaveBeenCalledTimes(40);
	} finally {
		await engine.destroy().toPromise();
		vi.restoreAllMocks();
	}
});
