/**
 * Built-in ("agentero") provider capability query.
 *
 * The Host compiles the credential in (or not); the WebView only ever learns
 * whether it is `available`. The base URL and model ids stay Host-side and are
 * never rendered — the whole point is that the user configures nothing.
 */

import { type BuiltinProviderStatus, commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";

/** Provider id literal, mirrored from the Host `BUILTIN_PROVIDER_ID`. */
export const BUILTIN_PROVIDER_ID = "agentero" as const;

/** Resolved status, or `null` when unavailable / not in a desktop build. */
let cached: BuiltinProviderStatus | null | undefined;
let inflight: Promise<BuiltinProviderStatus | null> | null = null;

/**
 * Capability is fixed at compile time, so one query per window is enough.
 * Concurrent callers share the in-flight promise; failures resolve to `null`
 * without a toast (this is a capability probe, not a user action).
 */
export async function loadBuiltinProviderStatus(): Promise<BuiltinProviderStatus | null> {
	if (cached !== undefined) return cached;
	if (inflight) return inflight;
	if (!isTauri()) {
		cached = null;
		return cached;
	}
	inflight = (async () => {
		try {
			const status = await callApi(() => commands.builtinProviderStatus());
			cached = status;
			return status;
		} catch {
			// Deliberately not cached: a transient IPC failure must not hide
			// the provider for the rest of the session.
			return null;
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}
