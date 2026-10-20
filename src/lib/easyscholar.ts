/**
 * EasyScholar key/probe helpers.
 *
 * Metrics are fetched and parsed by the Host (`paper_sync_publication`); the
 * renderer no longer builds `#easyscholar:` tags itself. This module keeps the
 * settings-facing helpers and the shared namespace predicate.
 */

import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";
import {
	EASY_SCHOLAR_TAG_PREFIX,
	isEasyScholarTagName,
} from "@/lib/paper/tag-namespaces";

export { EASY_SCHOLAR_TAG_PREFIX };

export type EasyScholarProbeStatus = "idle" | "probing" | "ok" | "fail";

/** Whether a tag belongs to the EasyScholar namespace. */
export function isEasyScholarTag(tag: string): boolean {
	return isEasyScholarTagName(tag);
}

/**
 * Host redacts API keys to the same number of `*` characters.
 * Must match `mask_translate_api_key` in `src-tauri/.../settings/mod.rs`.
 */
export function maskEasyScholarKey(key: string): string {
	const n = [...key.trim()].length;
	return n === 0 ? "" : "*".repeat(n);
}

export function isEasyScholarKeyMask(key: string | undefined): boolean {
	const t = key?.trim() ?? "";
	return t.length > 0 && /^\*+$/.test(t);
}

/** True when a non-empty key is stored (plaintext or Host `*`-mask). */
export function hasEasyScholarKey(key: string | undefined): boolean {
	return Boolean(key?.trim());
}

/**
 * Probe the configured EasyScholar key through the Host. The WebView never
 * sees the plaintext secret; the Host reads it from durable settings.
 */
export async function probeEasyScholarKey(
	signal?: AbortSignal,
): Promise<boolean> {
	if (!isTauri()) return false;
	try {
		const ok = await callApi(() => commands.easyScholarProbe(), {
			fallback: "EasyScholar probe failed",
		});
		if (signal?.aborted) return false;
		return ok;
	} catch {
		return false;
	}
}
