/** @vitest-environment happy-dom */
import { createDockview, type DockviewApi, themeAbyss } from "dockview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let api: DockviewApi;
let root: HTMLDivElement;
let entered: HTMLElement;
let pointerPosition = { clientX: 3, clientY: 50 };

function element(selector: string): HTMLElement {
	const found = root.querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`Missing Dockview element: ${selector}`);
	return found;
}

function drag(
	target: Element | Window,
	type: string,
	relatedTarget: EventTarget | null = null,
) {
	const event = new DragEvent(type, {
		bubbles: true,
		cancelable: true,
		relatedTarget,
		...pointerPosition,
	});
	// happy-dom does not populate DragEvent.relatedTarget from MouseEventInit.
	Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
	target.dispatchEvent(event);
}

function enter() {
	drag(entered, "dragenter");
	drag(entered, "dragover");
}

beforeEach(() => {
	pointerPosition = { clientX: 3, clientY: 50 };
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
		new DOMRect(0, 0, 800, 600),
	);
	root = document.createElement("div");
	document.body.append(root);
	api = createDockview(root, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
		dndStrategy: "pointer",
		theme: { ...themeAbyss, dndOverlayMounting: "absolute" },
		disableFloatingGroups: true,
	});
	api.addPanel({ id: "one", component: "test" });
	api.onUnhandledDragOver((event) => event.accept());
	entered = element(".dv-content-container");
});

afterEach(() => {
	api.dispose();
	root.remove();
	vi.restoreAllMocks();
});

describe("Dockview native overlay lifecycle", () => {
	it.each([
		{ name: "edge", clientX: 3, clientY: 50 },
		{ name: "group center", clientX: 400, clientY: 300 },
	])("clears a mismatched leave target and recreates the $name overlay on re-entry", (position) => {
		pointerPosition = position;
		enter();
		const first = root.querySelector(".dv-drop-target-container");
		expect(first?.isConnected).toBe(true);

		// WebKit can report the container rather than the child that dragenter saw.
		drag(element(".dv-dockview"), "dragleave");
		expect(root.querySelector(".dv-drop-target-container")).toBeNull();
		enter();
		const second = root.querySelector(".dv-drop-target-container");
		expect(second?.isConnected).toBe(true);
		expect(second).not.toBe(first);
	});

	it("preserves the overlay when moving between descendants", () => {
		enter();
		const first = root.querySelector(".dv-drop-target-container");
		drag(entered, "dragleave", entered.firstElementChild ?? entered);
		expect(root.querySelector(".dv-drop-target-container")).toBe(first);
	});

	it("clears overlays at the end of an external drag without accepting a drop", () => {
		const dropped = vi.fn();
		api.onDidDrop(dropped);
		enter();
		drag(window, "dragend");
		expect(root.querySelector(".dv-drop-target-container")).toBeNull();
		expect(dropped).not.toHaveBeenCalled();
		enter();
		expect(root.querySelector(".dv-drop-target-container")?.isConnected).toBe(
			true,
		);
	});
	it("accepts a real group-center drop once and resets the overlay for the next drag", () => {
		pointerPosition = { clientX: 400, clientY: 300 };
		const dropped = vi.fn();
		api.onDidDrop(dropped);
		enter();
		expect(root.querySelector(".dv-drop-target-container")?.isConnected).toBe(
			true,
		);
		drag(entered, "drop");
		expect(dropped).toHaveBeenCalledOnce();
		expect(root.querySelector(".dv-drop-target-container")).toBeNull();
		enter();
		expect(root.querySelector(".dv-drop-target-container")?.isConnected).toBe(
			true,
		);
	});
});
