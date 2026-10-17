import { useStore } from "zustand";
import { backgroundTasksStore } from "@/lib/core/background-tasks";

export function useBackgroundTasks() {
	// Select only the rows: `expanded` must not re-render the panel.
	const tasks = useStore(backgroundTasksStore, (s) => s.tasks);
	return { tasks };
}
