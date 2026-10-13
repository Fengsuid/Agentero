import { describe, expect, it } from "vitest";
import { decideComposerExternalValueSync } from "@/lib/agent/composer-sync";

describe("composer external value sync", () => {
	it("applies initial controlled values before the editor is focused", () => {
		expect(
			decideComposerExternalValueSync({
				nextValue: "saved draft",
				lastKnownDomValue: null,
				currentDomValue: "",
				focused: false,
				composing: false,
				awaitingParentEcho: false,
			}),
		).toBe("apply");
	});

	it("defers external draft refresh while composition owns focused DOM", () => {
		expect(
			decideComposerExternalValueSync({
				nextValue: "saved draft",
				lastKnownDomValue: "",
				currentDomValue: "first dictated phrase",
				focused: true,
				composing: true,
				awaitingParentEcho: false,
			}),
		).toBe("defer");
	});

	it("defers stale values while waiting for the parent input echo", () => {
		expect(
			decideComposerExternalValueSync({
				nextValue: "",
				lastKnownDomValue: "first dictated phrase",
				currentDomValue: "first dictated phrase",
				focused: true,
				composing: false,
				awaitingParentEcho: true,
			}),
		).toBe("defer");
	});

	it("skips once the parent has echoed the DOM value", () => {
		expect(
			decideComposerExternalValueSync({
				nextValue: "first dictated phrase",
				lastKnownDomValue: "first dictated phrase",
				currentDomValue: "first dictated phrase",
				focused: true,
				composing: false,
				awaitingParentEcho: true,
			}),
		).toBe("skip");
	});

	it("applies a pinned selection when the prose is unchanged", () => {
		expect(
			decideComposerExternalValueSync({
				nextValue: "对于 {{sel:abc}}",
				lastKnownDomValue: "对于",
				currentDomValue: "对于",
				focused: true,
				composing: false,
				awaitingParentEcho: true,
			}),
		).toBe("apply");
	});

	it("defers a selection sync that would drop text still in the field", () => {
		expect(
			decideComposerExternalValueSync({
				nextValue: "对于 {{sel:abc}}",
				lastKnownDomValue: "对于",
				currentDomValue: "对于 啊",
				focused: true,
				composing: false,
				awaitingParentEcho: true,
			}),
		).toBe("defer");
	});

	it("applies a quote inserted between words", () => {
		expect(
			decideComposerExternalValueSync({
				nextValue: "对于 {{sel:abc}} 这段",
				lastKnownDomValue: "对于这段",
				currentDomValue: "对于这段",
				focused: true,
				composing: false,
				awaitingParentEcho: true,
			}),
		).toBe("apply");
	});

	it("applies a visual reference when the prose is unchanged", () => {
		expect(
			decideComposerExternalValueSync({
				nextValue: "看 {{vis:mark-1}}",
				lastKnownDomValue: "看",
				currentDomValue: "看",
				focused: true,
				composing: false,
				awaitingParentEcho: true,
			}),
		).toBe("apply");
	});

	it("still applies inline token commits from the composer menu", () => {
		expect(
			decideComposerExternalValueSync({
				nextValue: "use {{m:papers%2Fdemo%2FNOTES.md}} ",
				lastKnownDomValue: "use @demo",
				currentDomValue: "use @demo",
				focused: true,
				composing: false,
				awaitingParentEcho: true,
			}),
		).toBe("apply");
	});
});
