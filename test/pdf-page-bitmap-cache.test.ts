import { describe, expect, it } from "vitest";
import { createPageBitmapCache } from "@/components/viewer/pdf/layers/page-bitmap-cache";

describe("page bitmap cache", () => {
	it("keeps a pinned bitmap when newer pages exceed the limit", () => {
		const cache = createPageBitmapCache(2);
		expect(cache.retain("p1")).toBeNull();
		expect(cache.store("p1", "blob:1", "s1")).toEqual([]);
		expect(cache.store("p2", "blob:2", "s1")).toEqual([]);
		expect(cache.store("p3", "blob:3", "s1")).toEqual(["blob:2"]);
		expect(cache.retain("p1")).toBe("blob:1");
		expect(cache.matches("p1", "s1")).toBe(true);
		expect(cache.matches("p1", "s2")).toBe(false);
	});

	it("returns the replaced bitmap and drops an unpinned page", () => {
		const cache = createPageBitmapCache(1);
		cache.store("p1", "blob:old", "s1");
		expect(cache.store("p1", "blob:new", "s2")).toEqual(["blob:old"]);
		cache.release("missing");
		expect(cache.store("p2", "blob:2", "s1")).toEqual(["blob:new"]);
	});
});
