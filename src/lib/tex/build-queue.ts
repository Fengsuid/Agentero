/** One active build operation, with one latest trailing request per project. */
type PendingBuild = {
	run: () => Promise<void>;
	priority: number;
	waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
};
const pending = new Map<string, PendingBuild>();
let active = false;

export function queueTexBuild(
	key: string,
	run: () => Promise<void>,
	priority = 0,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const previous = pending.get(key);
		const chosen =
			previous && previous.priority > priority ? previous : { run, priority };
		pending.set(key, {
			...chosen,
			waiters: [...(previous?.waiters ?? []), { resolve, reject }],
		});
		void drain();
	});
}

async function drain(): Promise<void> {
	if (active) return;
	active = true;
	try {
		while (pending.size) {
			const next = pending.entries().next().value;
			if (!next) break;
			const [key, request] = next;
			pending.delete(key);
			try {
				await request.run();
				for (const waiter of request.waiters) waiter.resolve();
			} catch (error) {
				for (const waiter of request.waiters) waiter.reject(error);
			}
		}
	} finally {
		active = false;
	}
}
