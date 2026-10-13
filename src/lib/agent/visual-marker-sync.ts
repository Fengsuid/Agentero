/**
 * Decide how one session's visual drafts and `{{vis:id}}` markers stay in step.
 * A composer swap replaces the visible bucket. That is not a deletion, and
 * drafts already stored for another session are not inserted here.
 * An explicit add (`requestedIds`) still inserts into the open composer,
 * even when this session already holds that draft.
 */

export type VisualMarkerBaseline = {
	identity: string;
	textIds: readonly string[];
	storeIds: readonly string[];
};

export type VisualMarkerSyncPlan = {
	/** Marker disappeared inside the same composer: drop the draft. */
	removeDraftIds: string[];
	/** Draft added inside the same composer and not yet in the text. */
	insertDraftIds: string[];
	/** Marker whose draft is already gone. */
	stripMarkerIds: string[];
};

export function planVisualMarkerSync(input: {
	identity: string;
	textIds: readonly string[];
	storeIds: readonly string[];
	prev: VisualMarkerBaseline | null;
	/** Mark ids the user just added from the current composer. */
	requestedIds?: readonly string[];
}): VisualMarkerSyncPlan {
	const inText = new Set(input.textIds);
	const inStore = new Set(input.storeIds);
	const requested = new Set(input.requestedIds ?? []);
	const stripMarkerIds = input.textIds.filter((id) => !inStore.has(id));
	const insert = (
		prevStore: ReadonlySet<string>,
		removed: ReadonlySet<string>,
	) =>
		input.storeIds.filter(
			(id) =>
				!inText.has(id) &&
				!removed.has(id) &&
				(requested.has(id) || !prevStore.has(id)),
		);

	if (!input.prev) {
		return {
			removeDraftIds: [],
			insertDraftIds: insert(new Set(), new Set()),
			stripMarkerIds,
		};
	}

	if (input.prev.identity !== input.identity) {
		return {
			removeDraftIds: [],
			insertDraftIds: insert(new Set(input.prev.storeIds), new Set()),
			stripMarkerIds,
		};
	}

	const removeDraftIds = input.prev.textIds.filter(
		(id) => !inText.has(id) && !requested.has(id),
	);
	return {
		removeDraftIds,
		insertDraftIds: insert(
			new Set(input.prev.storeIds),
			new Set(removeDraftIds),
		),
		stripMarkerIds,
	};
}
