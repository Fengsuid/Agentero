/**
 * Dual-pane scroll cost: shared tile bitmaps, scroller identity, and the
 * translation paragraph measure budget. The EmbedPDF patches call the same
 * helpers through `globalThis.__agenteroPdfScroll`.
 */
import "@/lib/pdf/dual-pane-scroll";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fitLayoutTranslateParagraph,
	type MeasurableParagraph,
	scheduleLayoutTranslateDomFit,
} from "@/lib/pdf/layout/layout-translate-dom-fit";
import { sameScrollerLayout } from "@/lib/pdf/scroller-layout";
import {
	createTileBitmapCache,
	noteTileBitmapDocument,
	tileBitmapShareKey,
	tileBlobs,
	tileUrls,
} from "@/lib/pdf/tile-bitmap-cache";

function pdfBytes(fill: number): ArrayBuffer {
	return new Uint8Array(64).fill(fill).buffer;
}

function layout(pageIndex: number, startSpacing = 0) {
	return {
		startSpacing,
		endSpacing: 40,
		totalWidth: 600,
		totalHeight: 2000,
		pageGap: 8,
		strategy: "vertical" as const,
		items: [
			{
				pageLayouts: [
					{
						pageIndex,
						rotatedWidth: 600,
						rotatedHeight: 800,
						width: 600,
						height: 800,
						elevated: false,
					},
				],
			},
		],
	};
}

function paragraph(
	text: string,
	box: { scrollHeight?: number; clientHeight?: number } = {},
): MeasurableParagraph {
	return {
		textContent: text,
		style: { fontSize: "", lineHeight: "", overflowWrap: "normal" },
		scrollHeight: box.scrollHeight ?? 10,
		clientHeight: box.clientHeight ?? 100,
		scrollWidth: 10,
		clientWidth: 100,
	};
}

const frames: Array<() => void> = [];
let now = 0;

beforeEach(() => {
	frames.length = 0;
	now = 0;
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	vi.spyOn(performance, "now").mockImplementation(() => now);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.push(() => callback(now));
		return frames.length;
	});
});

afterEach(() => {
	let guard = 0;
	while (frames.length > 0 && guard++ < 20) {
		const batch = frames.splice(0, frames.length);
		for (const run of batch) run();
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("tile bitmap share key", () => {
	it("installs the hooks the EmbedPDF patches call", () => {
		const hooks = (
			globalThis as { __agenteroPdfScroll?: { tileBitmapShareKey?: unknown } }
		).__agenteroPdfScroll;
		expect(typeof hooks?.tileBitmapShareKey).toBe("function");
	});

	it("stays on the document id until the bytes are registered", () => {
		expect(tileBitmapShareKey("pair-c::r1", "tile", 2)).toBe(
			"pair-c::r1\ntile\n2",
		);
		expect(tileBitmapShareKey("pair-c::translation::r2", "tile", 2)).toBe(
			"pair-c::translation::r2\ntile\n2",
		);
	});

	it("matches the source pane and the translation pane of the same bytes", () => {
		const bytes = pdfBytes(1);
		noteTileBitmapDocument("pair-a::r1", bytes);
		noteTileBitmapDocument("pair-a::translation::r2", bytes.slice(0));
		const source = tileBitmapShareKey("pair-a::r1", "tile", 2);
		expect(source).toBe(
			tileBitmapShareKey("pair-a::translation::r2", "tile", 2),
		);
		expect(source).not.toBe(tileBitmapShareKey("pair-a::r1", "tile", 1));
	});

	it("drops the previous stamp after a recompile", () => {
		noteTileBitmapDocument("pair-b::r1", pdfBytes(2));
		const key = tileBitmapShareKey("pair-b::r1", "tile", 2);
		tileBlobs.put(key, new Blob(["old"]));
		tileUrls.put(key, "blob:pair-b");
		noteTileBitmapDocument("pair-b::r3", pdfBytes(3));
		expect(tileBlobs.has(key)).toBe(false);
		expect(tileUrls.has(key)).toBe(false);
		expect(tileBitmapShareKey("pair-b::translation::r4", "tile", 2)).not.toBe(
			key,
		);
	});
});

describe("tile bitmap cache", () => {
	it("publishes one lead to a follower on a microtask", async () => {
		const cache = createTileBitmapCache<Blob>();
		expect(cache.claim("k", { resolve: () => {}, reject: () => {} }).kind).toBe(
			"lead",
		);
		const follower = { resolve: vi.fn(), reject: vi.fn() };
		expect(cache.claim("k", follower).kind).toBe("follow");
		const blob = new Blob(["tile"]);
		cache.publish("k", blob);
		expect(follower.resolve).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(follower.resolve).toHaveBeenCalledWith(blob);
		expect(cache.claim("k", { resolve: () => {}, reject: () => {} })).toEqual({
			kind: "cached",
			value: blob,
		});
	});

	it("aborts the lead only after the last follower leaves", () => {
		const cache = createTileBitmapCache<string>();
		expect(cache.claim("k", { resolve: () => {}, reject: () => {} }).kind).toBe(
			"lead",
		);
		const follower = { resolve: () => {}, reject: () => {} };
		cache.claim("k", follower);
		expect(cache.cancelLead("k")).toBe(false);
		cache.cancelFollow("k", follower);
		expect(cache.cancelLead("k")).toBe(true);
		expect(cache.cancelLead("k")).toBe(true);
	});

	it("keeps the first object URL and evicts the duplicate", () => {
		const evicted: string[] = [];
		const cache = createTileBitmapCache<string>({
			onEvict: (value) => evicted.push(value),
		});
		expect(cache.putIfAbsent("k", "blob:first")).toBe("blob:first");
		expect(cache.putIfAbsent("k", "blob:second")).toBe("blob:first");
		expect(evicted).toEqual(["blob:second"]);
		expect(cache.get("k")).toBe("blob:first");
	});
});

describe("sameScrollerLayout", () => {
	it("treats a fresh object with the same mounted window as equal", () => {
		expect(sameScrollerLayout(layout(0), layout(0))).toBe(true);
		expect(sameScrollerLayout(layout(0), null)).toBe(false);
	});

	it("changes when the page window or spacing changes", () => {
		expect(sameScrollerLayout(layout(0), layout(1))).toBe(false);
		expect(sameScrollerLayout(layout(0, 0), layout(0, 800))).toBe(false);
	});
});

describe("layout translate DOM fit", () => {
	it("keeps the initial size when the first leading fits", () => {
		const element = paragraph("你好");
		expect(
			fitLayoutTranslateParagraph(element, {
				text: "你好",
				initialFontSize: 16,
				isHeading: false,
			}),
		).toEqual({ fontSize: 16, lineHeight: 1.25, overflowWrap: "normal" });
	});

	it("returns null when even the floor with relaxed wrapping overflows", () => {
		const element = paragraph("overflow", {
			scrollHeight: 500,
			clientHeight: 10,
		});
		expect(
			fitLayoutTranslateParagraph(element, {
				text: "overflow",
				initialFontSize: 16,
				isHeading: false,
			}),
		).toBeNull();
		expect(element.style.overflowWrap).toBe("anywhere");
	});

	it("moves the next measure to the following frame and drops it on cancel", () => {
		const ran: string[] = [];
		scheduleLayoutTranslateDomFit(() => {
			now += 5;
			ran.push("a");
		});
		const cancel = scheduleLayoutTranslateDomFit(() => {
			ran.push("b");
		});
		expect(ran).toEqual(["a"]);
		cancel();
		frames.shift()?.();
		expect(ran).toEqual(["a"]);

		scheduleLayoutTranslateDomFit(() => {
			now += 5;
			ran.push("c");
		});
		scheduleLayoutTranslateDomFit(() => {
			ran.push("d");
		});
		frames.shift()?.();
		expect(ran).toEqual(["a", "c", "d"]);
	});
});
