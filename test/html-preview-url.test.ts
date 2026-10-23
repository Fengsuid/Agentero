import { afterEach, describe, expect, it, vi } from "vitest";

import {
	LOCAL_HTML_SANDBOX,
	localHtmlPreviewUrl,
} from "@/lib/web-view/html-preview-url";

function stubUserAgent(value: string) {
	vi.stubGlobal("navigator", { userAgent: value });
}

describe("localHtmlPreviewUrl", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("keeps the file name as the last segment", () => {
		stubUserAgent("Mozilla/5.0 (Macintosh)");
		expect(
			localHtmlPreviewUrl("0123456789abcdef0123456789abcdef", "logic.html", 3),
		).toBe(
			"agentero-html://localhost/t/0123456789abcdef0123456789abcdef/logic.html?v=3",
		);
	});

	it("uses the WebView2 http form on Windows", () => {
		stubUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		expect(
			localHtmlPreviewUrl("abcdef0123456789abcdef0123456789", "a.html", 1),
		).toBe(
			"http://agentero-html.localhost/t/abcdef0123456789abcdef0123456789/a.html?v=1",
		);
	});

	it("encodes spaces in the file name", () => {
		stubUserAgent("Mozilla/5.0 (Macintosh)");
		expect(
			localHtmlPreviewUrl(
				"0123456789abcdef0123456789abcdef",
				"my logic.html",
				0,
			),
		).toBe(
			"agentero-html://localhost/t/0123456789abcdef0123456789abcdef/my%20logic.html?v=0",
		);
	});
});

describe("LOCAL_HTML_SANDBOX", () => {
	it("allows scripts and stays an opaque origin", () => {
		expect(LOCAL_HTML_SANDBOX.split(/\s+/)).toEqual(["allow-scripts"]);
	});
});
