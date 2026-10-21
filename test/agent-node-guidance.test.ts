import { describe, expect, it } from "vitest";
import {
	isLifecycleNodeBlocked,
	lifecycleNeedsNode,
	type NodeDependentEntry,
} from "@/lib/doctor/node-guidance";

function entry(
	overrides: Partial<NodeDependentEntry> = {},
): NodeDependentEntry {
	return {
		adapterDistinct: false,
		acpBundled: false,
		templateId: "claude-acp",
		...overrides,
	};
}

const bothMissing = { nodeMissing: true, npmMissing: true };
const nodeOnlyMissing = { nodeMissing: true, npmMissing: false };
const npmOnlyMissing = { nodeMissing: false, npmMissing: true };
const hostReady = { nodeMissing: false, npmMissing: false };

describe("lifecycleNeedsNode", () => {
	it("flags separate npm ACP adapters for install and update", () => {
		const claude = entry({ adapterDistinct: true });
		expect(lifecycleNeedsNode(claude, "install")).toBe(true);
		expect(lifecycleNeedsNode(claude, "update")).toBe(true);
	});

	it("flags a bundled JS adapter tier even without a distinct adapter", () => {
		expect(lifecycleNeedsNode(entry({ acpBundled: true }), "install")).toBe(
			true,
		);
	});

	it("flags host CLIs whose install/update is npm-only everywhere", () => {
		for (const templateId of ["dsh", "minimax-code", "mimo-code"]) {
			expect(lifecycleNeedsNode(entry({ templateId }), "install")).toBe(true);
			expect(lifecycleNeedsNode(entry({ templateId }), "update")).toBe(true);
		}
	});

	it("flags OpenCode only on Windows, where it has no native installer", () => {
		const opencode = entry({ templateId: "opencode" });
		expect(lifecycleNeedsNode(opencode, "install", "windows")).toBe(true);
		expect(lifecycleNeedsNode(opencode, "update", "windows")).toBe(true);
		expect(lifecycleNeedsNode(opencode, "install", "macos")).toBe(false);
		expect(lifecycleNeedsNode(opencode, "install", "linux")).toBe(false);
	});

	it("never flags uninstall: removing an Agent must stay possible", () => {
		expect(
			lifecycleNeedsNode(entry({ adapterDistinct: true }), "uninstall"),
		).toBe(false);
		expect(lifecycleNeedsNode(entry({ acpBundled: true }), "uninstall")).toBe(
			false,
		);
		expect(lifecycleNeedsNode(entry({ templateId: "dsh" }), "uninstall")).toBe(
			false,
		);
	});

	it("keeps native ACP binary installs and updates unchanged", () => {
		for (const templateId of ["hermes", "qodercli", "kimi-code"]) {
			expect(lifecycleNeedsNode(entry({ templateId }), "install")).toBe(false);
			expect(lifecycleNeedsNode(entry({ templateId }), "update")).toBe(false);
		}
	});
});

describe("isLifecycleNodeBlocked", () => {
	it("does not block a healthy host", () => {
		expect(
			isLifecycleNodeBlocked(
				entry({ adapterDistinct: true }),
				"install",
				hostReady,
			),
		).toBe(false);
	});

	it("does not block before the first host probe resolves", () => {
		expect(
			isLifecycleNodeBlocked(entry({ adapterDistinct: true }), "install", null),
		).toBe(false);
	});

	it("blocks adapter installs when Node.js is missing", () => {
		expect(
			isLifecycleNodeBlocked(
				entry({ adapterDistinct: true }),
				"install",
				bothMissing,
			),
		).toBe(true);
		expect(
			isLifecycleNodeBlocked(
				entry({ adapterDistinct: true }),
				"install",
				nodeOnlyMissing,
			),
		).toBe(true);
	});

	it("blocks adapter updates when only npm is missing", () => {
		expect(
			isLifecycleNodeBlocked(
				entry({ adapterDistinct: true }),
				"update",
				npmOnlyMissing,
			),
		).toBe(true);
	});

	it("blocks npm-only host CLI installs when Node.js is missing", () => {
		expect(
			isLifecycleNodeBlocked(
				entry({ templateId: "dsh" }),
				"install",
				bothMissing,
			),
		).toBe(true);
	});

	it("leaves native binary installs and uninstalls alone", () => {
		expect(isLifecycleNodeBlocked(entry(), "install", bothMissing)).toBe(false);
		expect(
			isLifecycleNodeBlocked(
				entry({ adapterDistinct: true }),
				"uninstall",
				bothMissing,
			),
		).toBe(false);
		expect(
			isLifecycleNodeBlocked(
				entry({ templateId: "dsh" }),
				"uninstall",
				bothMissing,
			),
		).toBe(false);
	});
});
