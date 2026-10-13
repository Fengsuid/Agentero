import { describe, expect, it } from "vitest";
import {
	planVisualMarkerSync,
	type VisualMarkerBaseline,
} from "@/lib/agent/visual-marker-sync";

const sessionA = "vault\nsession-a";
const sessionB = "vault\nsession-b";

function baseline(
	identity: string,
	textIds: string[],
	storeIds: string[],
): VisualMarkerBaseline {
	return { identity, textIds, storeIds };
}

describe("planVisualMarkerSync", () => {
	it("inserts a draft added inside the same composer", () => {
		const plan = planVisualMarkerSync({
			identity: sessionA,
			textIds: [],
			storeIds: ["mark-1"],
			prev: baseline(sessionA, [], []),
		});
		expect(plan).toEqual({
			removeDraftIds: [],
			insertDraftIds: ["mark-1"],
			stripMarkerIds: [],
		});
	});

	it("drops a draft when its marker is deleted in the same composer", () => {
		const plan = planVisualMarkerSync({
			identity: sessionA,
			textIds: [],
			storeIds: ["mark-1"],
			prev: baseline(sessionA, ["mark-1"], ["mark-1"]),
		});
		expect(plan.removeDraftIds).toEqual(["mark-1"]);
		expect(plan.insertDraftIds).toEqual([]);
	});

	it("strips a marker whose draft is already gone", () => {
		const plan = planVisualMarkerSync({
			identity: sessionA,
			textIds: ["mark-1"],
			storeIds: [],
			prev: baseline(sessionA, ["mark-1"], ["mark-1"]),
		});
		expect(plan.stripMarkerIds).toEqual(["mark-1"]);
		expect(plan.removeDraftIds).toEqual([]);
	});

	it("does not treat a composer switch as deleting or inserting the other draft", () => {
		const plan = planVisualMarkerSync({
			identity: sessionB,
			textIds: [],
			storeIds: ["mark-1"],
			prev: baseline(sessionA, ["mark-1"], ["mark-1"]),
		});
		expect(plan).toEqual({
			removeDraftIds: [],
			insertDraftIds: [],
			stripMarkerIds: [],
		});
	});

	it("still inserts a draft that appears in the same update as a composer switch", () => {
		const plan = planVisualMarkerSync({
			identity: sessionB,
			textIds: [],
			storeIds: ["mark-1", "mark-2"],
			prev: baseline(sessionA, ["mark-1"], ["mark-1"]),
		});
		expect(plan.insertDraftIds).toEqual(["mark-2"]);
		expect(plan.removeDraftIds).toEqual([]);
	});

	it("inserts a requested draft the other composer already queued", () => {
		const plan = planVisualMarkerSync({
			identity: sessionB,
			textIds: [],
			storeIds: ["mark-1"],
			prev: baseline(sessionB, [], ["mark-1"]),
			requestedIds: ["mark-1"],
		});
		expect(plan.insertDraftIds).toEqual(["mark-1"]);
		expect(plan.removeDraftIds).toEqual([]);
	});

	it("does not insert a requested draft that is already in this composer", () => {
		const plan = planVisualMarkerSync({
			identity: sessionB,
			textIds: ["mark-1"],
			storeIds: ["mark-1"],
			prev: baseline(sessionB, ["mark-1"], ["mark-1"]),
			requestedIds: ["mark-1"],
		});
		expect(plan.insertDraftIds).toEqual([]);
		expect(plan.removeDraftIds).toEqual([]);
	});

	it("keeps the previous composer's draft out after the switch settles", () => {
		const switched = planVisualMarkerSync({
			identity: sessionB,
			textIds: [],
			storeIds: ["mark-1"],
			prev: baseline(sessionA, ["mark-1"], ["mark-1"]),
		});
		const settled = planVisualMarkerSync({
			identity: sessionB,
			textIds: [],
			storeIds: ["mark-1", "mark-2"],
			prev: baseline(sessionB, [], ["mark-1"]),
		});
		expect(switched.insertDraftIds).toEqual([]);
		expect(settled.insertDraftIds).toEqual(["mark-2"]);
		expect(settled.removeDraftIds).toEqual([]);
	});
});
