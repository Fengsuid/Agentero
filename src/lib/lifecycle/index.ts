import { emit, emitScoped, on } from "@/lib/lifecycle/bus";

export type { Teardown } from "@/lib/lifecycle/bus";
export type { LifecycleEvent, LifecycleEventMap } from "@/lib/lifecycle/events";
export type { PublicLifecycleEvent } from "@/lib/lifecycle/public";
export { onPublic, PUBLIC_LIFECYCLE_EVENTS } from "@/lib/lifecycle/public";
export { initLifecycleBridge } from "@/lib/lifecycle/tauri-bridge";

export const lifecycle = { on, emit, emitScoped };
