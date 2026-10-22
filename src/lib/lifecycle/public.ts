import { on, type Teardown } from "@/lib/lifecycle/bus";
import type {
	FactLifecycleEvent,
	LifecycleEventMap,
	ScopedLifecycleEvent,
} from "@/lib/lifecycle/events";

/**
 * Same five names as `public_events()` in
 * `crates/agentero-core/src/ops/events.rs`.
 */
export const PUBLIC_LIFECYCLE_EVENTS = [
	"vault:opened",
	"paper:imported",
	"paper:assets-ready",
	"paper:renamed",
	"paper:opened",
] as const satisfies readonly (keyof LifecycleEventMap)[];

export type PublicLifecycleEvent = (typeof PUBLIC_LIFECYCLE_EVENTS)[number];

type PublicScopedEvent = PublicLifecycleEvent & ScopedLifecycleEvent;
type PublicFactEvent = PublicLifecycleEvent & FactLifecycleEvent;

type PublicScopedHandler<E extends PublicScopedEvent> = (
	payload: LifecycleEventMap[E],
) => Teardown | void | Promise<Teardown> | Promise<void>;

type PublicFactHandler<E extends PublicFactEvent> = (
	payload: LifecycleEventMap[E],
) => void | Promise<void>;

/**
 * Subscribe to one public lifecycle event on the in-webview bus.
 * Delegates to `on` and returns the same unsubscribe function.
 * The desktop plugin bridge forwards these events to authorized instances.
 */
export function onPublic<E extends PublicScopedEvent>(
	event: E,
	handler: PublicScopedHandler<E>,
): () => void;
export function onPublic<E extends PublicFactEvent>(
	event: E,
	handler: PublicFactHandler<E>,
): () => void;
export function onPublic(
	event: PublicLifecycleEvent,
	handler: (payload: LifecycleEventMap[PublicLifecycleEvent]) => unknown,
): () => void {
	if (event === "vault:opened") {
		return on(event, handler as PublicScopedHandler<"vault:opened">);
	}
	return on(
		event,
		handler as PublicFactHandler<Exclude<PublicLifecycleEvent, "vault:opened">>,
	);
}
