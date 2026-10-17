/**
 * Last base-coat bitmap for a PDF page.
 *
 * The scroller unmounts pages that leave the buffer, and a zoom starts a new
 * raster before the old one can stay on screen. Without this cache the page
 * renders nothing until PDFium returns, which is the blank flash during a
 * fast scroll. Slots stay pinned while a page layer is mounted so eviction
 * cannot revoke a blob the screen is still showing.
 */

const DEFAULT_PAGE_BITMAP_LIMIT = 24;

type Slot = {
	url: string;
	pins: number;
	key: string;
};

export type PageBitmapCache = {
	/** Pin `id` and return its bitmap, if one is already stored. */
	retain(id: string): string | null;
	release(id: string): void;
	/** True when `id` already shows a bitmap produced for `key`. */
	matches(id: string, key: string): boolean;
	/**
	 * Remember `url` for `id` at `key`. The returned blob URLs are no longer
	 * referenced by the cache; the caller revokes them after the replacement
	 * has painted.
	 */
	store(id: string, url: string, key: string): string[];
};

export function createPageBitmapCache(
	limit = DEFAULT_PAGE_BITMAP_LIMIT,
): PageBitmapCache {
	const slots = new Map<string, Slot>();

	function touch(id: string, slot: Slot) {
		slots.delete(id);
		slots.set(id, slot);
	}

	function evict(): string[] {
		const dropped: string[] = [];
		for (const [id, slot] of slots) {
			if (slots.size <= limit) break;
			if (slot.pins > 0 || !slot.url) continue;
			slots.delete(id);
			dropped.push(slot.url);
		}
		return dropped;
	}

	return {
		retain(id) {
			const existing = slots.get(id);
			if (!existing) {
				slots.set(id, { url: "", pins: 1, key: "" });
				return null;
			}
			existing.pins += 1;
			touch(id, existing);
			return existing.url || null;
		},
		release(id) {
			const slot = slots.get(id);
			if (!slot) return;
			slot.pins = Math.max(0, slot.pins - 1);
			if (slot.pins === 0 && !slot.url) slots.delete(id);
		},
		matches(id, key) {
			const slot = slots.get(id);
			return Boolean(slot?.url && slot.key === key);
		},
		store(id, url, key) {
			const existing = slots.get(id);
			const retired: string[] = [];
			if (existing) {
				if (existing.url && existing.url !== url) retired.push(existing.url);
				existing.url = url;
				existing.key = key;
				touch(id, existing);
			} else {
				slots.set(id, { url, pins: 0, key });
			}
			retired.push(...evict());
			return retired;
		},
	};
}

export const pageBitmapCache = createPageBitmapCache();
