/**
 * Shared PDFium tile bitmaps for the two EmbedPDF instances in dual-pane
 * translation.
 *
 * Each pane has its own document id (`tab::rN` and `tab::translation::rM`)
 * and would otherwise rasterize the same page twice on the one worker.
 * The share key drops the `::translation` suffix and the per-buffer revision,
 * then adds a fingerprint of the bytes taken when the viewer opened, so a
 * recompile does not reuse the previous paper's tiles.
 *
 * The EmbedPDF tiling patch reads `globalThis.__agenteroPdfScroll`.
 */

export const TILE_BITMAP_CACHE_MAX = 32;

export type TileWaiter<T> = {
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

export type TileClaim<T> =
	| { kind: "cached"; value: T }
	| { kind: "follow"; waiter: TileWaiter<T> }
	| { kind: "lead" };

type Flight<T> = {
	followers: Set<TileWaiter<T>>;
};

const TRANSLATION_SUFFIX = "::translation";

export function tilePairBase(documentId: string): string {
	const revision = /::r\d+$/.exec(documentId);
	const withoutRevision = revision
		? documentId.slice(0, -revision[0].length)
		: documentId;
	return withoutRevision.endsWith(TRANSLATION_SUFFIX)
		? withoutRevision.slice(0, -TRANSLATION_SUFFIX.length)
		: withoutRevision;
}

/** FNV-1a over length plus 32 evenly spaced bytes. Enough to tell recompiles apart. */
export function tileDocumentFingerprint(bytes: ArrayBuffer | null): string {
	if (!bytes) return "url";
	const view = new Uint8Array(bytes);
	let hash = 0x811c9dc5;
	const step = Math.max(1, Math.floor(view.length / 32));
	for (let i = 0; i < view.length; i += step) {
		hash ^= view[i] ?? 0;
		hash = Math.imul(hash, 0x01000193);
	}
	hash ^= view.length;
	return (hash >>> 0).toString(36);
}

const documentStamps = new Map<string, string>();

export function createTileBitmapCache<T>(options?: {
	max?: number;
	onEvict?: (value: T) => void;
}) {
	const max = options?.max ?? TILE_BITMAP_CACHE_MAX;
	const onEvict = options?.onEvict;
	const ready = new Map<string, T>();
	const inflight = new Map<string, Flight<T>>();

	const evictOverflow = () => {
		while (ready.size > max) {
			const oldest = ready.keys().next().value;
			if (oldest === undefined) return;
			const value = ready.get(oldest);
			ready.delete(oldest);
			if (value !== undefined) onEvict?.(value);
		}
	};

	const remember = (key: string, value: T) => {
		if (ready.has(key)) ready.delete(key);
		ready.set(key, value);
		evictOverflow();
	};

	return {
		get(key: string): T | undefined {
			const value = ready.get(key);
			if (value === undefined) return undefined;
			ready.delete(key);
			ready.set(key, value);
			return value;
		},
		has(key: string): boolean {
			return ready.has(key);
		},
		put(key: string, value: T): void {
			remember(key, value);
		},
		/** Keep the first value. A duplicate is evicted so its URL can be revoked. */
		putIfAbsent(key: string, value: T): T {
			const existing = ready.get(key);
			if (existing !== undefined) {
				ready.delete(key);
				ready.set(key, existing);
				if (existing !== value) onEvict?.(value);
				return existing;
			}
			remember(key, value);
			return value;
		},
		claim(key: string, waiter: TileWaiter<T>): TileClaim<T> {
			const hit = ready.get(key);
			if (hit !== undefined) {
				ready.delete(key);
				ready.set(key, hit);
				return { kind: "cached", value: hit };
			}
			const flight = inflight.get(key);
			if (flight) {
				flight.followers.add(waiter);
				return { kind: "follow", waiter };
			}
			inflight.set(key, { followers: new Set() });
			return { kind: "lead" };
		},
		publish(key: string, value: T): void {
			const flight = inflight.get(key);
			inflight.delete(key);
			remember(key, value);
			if (!flight) return;
			queueMicrotask(() => {
				for (const follower of flight.followers) follower.resolve(value);
			});
		},
		fail(key: string, error: unknown): void {
			const flight = inflight.get(key);
			inflight.delete(key);
			if (!flight) return;
			queueMicrotask(() => {
				for (const follower of flight.followers) follower.reject(error);
			});
		},
		cancelFollow(key: string, waiter: TileWaiter<T>): void {
			inflight.get(key)?.followers.delete(waiter);
		},
		/**
		 * The leading caller is going away. Keep the in-flight render when a
		 * follower still wants the bitmap; otherwise the caller should abort it.
		 */
		cancelLead(key: string): boolean {
			const flight = inflight.get(key);
			if (!flight) return true;
			if (flight.followers.size > 0) return false;
			inflight.delete(key);
			return true;
		},
		dropByPrefix(prefix: string): void {
			for (const key of [...ready.keys()]) {
				if (!key.startsWith(prefix)) continue;
				const value = ready.get(key);
				ready.delete(key);
				if (value !== undefined) onEvict?.(value);
			}
		},
	};
}

function revokeTileUrl(url: string): void {
	if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

export const tileBlobs = createTileBitmapCache<Blob>({
	max: TILE_BITMAP_CACHE_MAX,
});

export const tileUrls = createTileBitmapCache<string>({
	max: TILE_BITMAP_CACHE_MAX,
	onEvict: revokeTileUrl,
});

export function noteTileBitmapDocument(
	documentId: string,
	bytes: ArrayBuffer | null,
): void {
	const base = tilePairBase(documentId);
	const next = tileDocumentFingerprint(bytes);
	const prev = documentStamps.get(base);
	if (prev === next) return;
	documentStamps.set(base, next);
	if (prev === undefined) return;
	const prefix = `${prev}\n`;
	tileBlobs.dropByPrefix(prefix);
	tileUrls.dropByPrefix(prefix);
}

export function tileBitmapShareKey(
	documentId: string,
	tileId: string,
	dpr: number,
): string {
	const base = tilePairBase(documentId);
	const stamp = documentStamps.get(base) ?? documentId;
	return `${stamp}\n${tileId}\n${dpr}`;
}
