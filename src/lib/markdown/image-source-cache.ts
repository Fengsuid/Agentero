import {
	localImageToViewerSource,
	revokePdfViewerSource,
} from "@/lib/paper/media";

/**
 * Shared `blob:` source cache for Markdown-local images.
 *
 * The same image (e.g. one figure referenced twice, or a note reopened after
 * its editor was evicted) used to be read from disk and turned into a fresh
 * object URL per `<img>` mount. This keeps at most {@link CACHE_LIMIT} decoded
 * sources alive, shares them across instances with refcounting, and evicts
 * (revoking) only unreferenced entries. Bounded memory, one read per path.
 */
const CACHE_LIMIT = 48;

type CacheEntry = {
	url: string;
	refs: number;
	loading: Promise<string | null> | null;
};

const cache = new Map<string, CacheEntry>();

function cacheKey(absPath: string, mime: string): string {
	return `${absPath}\u0000${mime}`;
}

function evict(): void {
	if (cache.size <= CACHE_LIMIT) return;
	for (const [key, entry] of cache) {
		if (entry.refs > 0 || entry.loading) continue;
		cache.delete(key);
		if (entry.url) revokePdfViewerSource(entry.url);
		if (cache.size <= CACHE_LIMIT) return;
	}
}

/**
 * Acquire a shared source for `absPath`. Callers must pair every successful
 * call with {@link releaseImageSource} on unmount.
 */
export function acquireImageSource(
	absPath: string,
	mime: string,
): Promise<string | null> {
	const key = cacheKey(absPath, mime);
	let entry = cache.get(key);
	if (!entry) {
		entry = { refs: 0, url: "", loading: null };
		cache.set(key, entry);
	}
	// Refresh LRU order.
	cache.delete(key);
	cache.set(key, entry);
	entry.refs += 1;

	if (entry.url) return Promise.resolve(entry.url);
	if (!entry.loading) {
		const current = entry;
		current.loading = localImageToViewerSource(absPath, mime)
			.then((url) => {
				current.url = url ?? "";
				return current.url || null;
			})
			.finally(() => {
				current.loading = null;
			});
	}
	evict();
	return entry.loading ?? Promise.resolve(null);
}

/** Release one reference; schedules eviction of unreferenced entries. */
export function releaseImageSource(absPath: string, mime: string): void {
	const key = cacheKey(absPath, mime);
	const entry = cache.get(key);
	if (!entry) return;
	entry.refs = Math.max(0, entry.refs - 1);
	evict();
}
