import type { JobTerminalPayload_Deserialize } from "@/lib/core/bindings";

export type LifecycleEventMap = {
	"app:ready": { timestamp: number };
	"vault:opened": { vaultId: string; timestamp: number };
	/** Host-emitted; payload matches `WindowClosedPayload` (no timestamp). */
	"window:closed": { kind: string; view?: string | null };
	"paper:imported": { vaultId: string; paperId: string; timestamp: number };
	"paper:assets-ready": { vaultId: string; paperId: string; timestamp: number };
	/** Deferred recognition renamed a paper folder or merged it into an existing entry. */
	"paper:renamed": {
		vaultId: string;
		oldPaperId: string;
		newPaperId: string;
		/** Vault-relative folder paths. */
		oldPath: string;
		newPath: string;
		/** Semantically `renamed` | `merged`; the wire keeps Rust's `String`. */
		outcome: string;
		/** Markdown sources whose internal links the rename transaction rewrote. */
		updatedSources: string[];
		timestamp: number;
	};
	"paper:opened": { paperId: string; timestamp: number };
	/**
	 * Host-emitted terminal job fact; `job:completed` / `job:failed` share this
	 * generated wire payload. `paperId` / `error` are omitted when unset.
	 */
	"job:completed": JobTerminalPayload_Deserialize;
	"job:failed": JobTerminalPayload_Deserialize;
	/** Host-emitted after any agent registry mutation (probe/install/default). */
	"agent:registry-changed": Record<string, never>;
};

export type LifecycleEvent = keyof LifecycleEventMap;

/**
 * Events with a lifetime. Handlers may return a teardown, run when the emitter
 * releases the scope (see `emitScoped`). Re-emitting does NOT imply teardown:
 * the emitter owns the scope, so React effect cleanup drives it.
 */
export type ScopedLifecycleEvent = "vault:opened";

/** One-shot facts. Any value a handler returns is ignored — no teardown slot. */
export type FactLifecycleEvent = Exclude<LifecycleEvent, ScopedLifecycleEvent>;
