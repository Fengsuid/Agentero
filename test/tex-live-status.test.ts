import { describe, expect, it } from "vitest";
import { useTexLiveStatusStore } from "@/lib/tex-live/status";

describe("live preview status ownership", () => {
	it("keeps the surviving pane ready when its sibling closes", () => {
		const { setStatus, clearStatus } = useTexLiveStatusStore.getState();
		const first = Symbol();
		const second = Symbol();
		const root = "/vault/main.tex";
		const ready = { status: "live" as const, error: null };
		setStatus(root, ready, first);
		setStatus(root, ready, second);
		clearStatus(root, first);
		expect(useTexLiveStatusStore.getState().byRoot[root]).toEqual(ready);
		clearStatus(root, second);
		expect(useTexLiveStatusStore.getState().byRoot[root]).toBeUndefined();
	});

	it("restores the remaining pane's last status when the latest publisher closes", () => {
		const { setStatus, clearStatus } = useTexLiveStatusStore.getState();
		const first = Symbol();
		const second = Symbol();
		const root = "/vault/other.tex";
		const failed = { status: "failed" as const, error: "engine failed" };
		setStatus(root, failed, first);
		setStatus(root, { status: "live", error: null }, second);
		clearStatus(root, second);
		expect(useTexLiveStatusStore.getState().byRoot[root]).toEqual(failed);
		clearStatus(root, first);
	});

	it("ignores repeated or unrelated pane cleanup without clearing a surviving publisher", () => {
		const { setStatus, clearStatus } = useTexLiveStatusStore.getState();
		const owner = Symbol();
		const unknown = Symbol();
		const root = "/vault/final.tex";
		const waiting = { status: "waiting" as const, error: null };
		setStatus(root, waiting, owner);
		clearStatus(root, unknown);
		clearStatus(root, unknown);
		expect(useTexLiveStatusStore.getState().byRoot[root]).toEqual(waiting);
		clearStatus(root, owner);
		clearStatus(root, owner);
		expect(useTexLiveStatusStore.getState().byRoot[root]).toBeUndefined();
	});
});
