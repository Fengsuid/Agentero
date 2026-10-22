import { expect, it, vi } from "vitest";
import { queueTexBuild } from "@/lib/tex/build-queue";

it("serializes projects and coalesces their trailing requests", async () => {
	let finish!: () => void;
	const sequence: string[] = [];
	const first = queueTexBuild(
		"a",
		() =>
			new Promise<void>((resolve) => {
				sequence.push("first");
				finish = resolve;
			}),
	);
	const old = queueTexBuild("a", async () => {
		sequence.push("obsolete");
	});
	const other = queueTexBuild("b", async () => {
		sequence.push("other");
	});
	const latest = queueTexBuild("a", async () => {
		sequence.push("latest");
	});
	finish();
	await Promise.all([first, old, other, latest]);
	expect(sequence).toEqual(["first", "latest", "other"]);
});

it("keeps a queued explicit rebuild when an automatic request arrives", async () => {
	let finish!: () => void;
	const first = queueTexBuild(
		"a",
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const rebuild = vi.fn(async () => undefined);
	const automatic = vi.fn(async () => undefined);
	const manual = queueTexBuild("a", rebuild, 2);
	const auto = queueTexBuild("a", automatic);
	finish();
	await Promise.all([first, manual, auto]);
	expect(rebuild).toHaveBeenCalledOnce();
	expect(automatic).not.toHaveBeenCalled();
});

it("releases the queue after a failed operation", async () => {
	const failed = queueTexBuild("bad", async () => {
		throw new Error("failed");
	});
	const next = vi.fn(async () => undefined);
	const done = queueTexBuild("next", next);
	await expect(failed).rejects.toThrow("failed");
	await done;
	expect(next).toHaveBeenCalledOnce();
});
