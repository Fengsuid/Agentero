/**
 * Scroller identity and the translation paragraph measure budget.
 */
import "@/lib/pdf/dual-pane-scroll";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fitLayoutTranslateParagraph,
	type MeasurableParagraph,
	scheduleLayoutTranslateDomFit,
} from "@/lib/pdf/layout/layout-translate-dom-fit";
import { sameScrollerLayout } from "@/lib/pdf/scroller-layout";

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

describe("sameScrollerLayout", () => {
	it("installs the comparator the EmbedPDF scroll patch calls", () => {
		const hooks = (
			globalThis as { __agenteroPdfScroll?: { sameScrollerLayout?: unknown } }
		).__agenteroPdfScroll;
		expect(hooks?.sameScrollerLayout).toBe(sameScrollerLayout);
	});

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
