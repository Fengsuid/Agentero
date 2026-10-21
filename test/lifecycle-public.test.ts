import { beforeEach, describe, expect, it, vi } from "vitest";
import { emit } from "@/lib/lifecycle/bus";
import { onPublic, PUBLIC_LIFECYCLE_EVENTS } from "@/lib/lifecycle/public";

vi.mock("@/lib/core/logger", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe("public lifecycle subscription", () => {
	const offs: Array<() => void> = [];

	beforeEach(() => {
		for (const off of offs) off();
		offs.length = 0;
	});

	it("receives paper:imported from emit and stops after unsubscribe", async () => {
		const seen: Array<{ vaultId: string; paperId: string; timestamp: number }> =
			[];
		const off = onPublic("paper:imported", (payload) => {
			seen.push(payload);
		});
		offs.push(off);

		const first = { vaultId: "vault", paperId: "paper-a", timestamp: 1 };
		await emit("paper:imported", first);
		expect(seen).toEqual([first]);

		off();
		await emit("paper:imported", {
			vaultId: "vault",
			paperId: "paper-b",
			timestamp: 2,
		});
		expect(seen).toEqual([first]);
	});

	it("lists exactly the five public event names", () => {
		// Internal names such as "window:closed" are not in PublicLifecycleEvent.
		// Passing one to onPublic is a compile error in src/ (tsconfig does not
		// include tests). This list must match public_events() in
		// crates/agentero-core/src/ops/events.rs.
		expect([...PUBLIC_LIFECYCLE_EVENTS]).toEqual([
			"vault:opened",
			"paper:imported",
			"paper:assets-ready",
			"paper:renamed",
			"paper:opened",
		]);
	});
});
