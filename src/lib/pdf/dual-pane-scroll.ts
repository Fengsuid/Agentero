/**
 * Install the layout comparator the EmbedPDF scroll patch calls.
 * Importing this module from the PDF viewer is enough for both panes.
 */

import { sameScrollerLayout } from "@/lib/pdf/scroller-layout";
export type AgenteroPdfScrollHooks = {
	sameScrollerLayout: typeof sameScrollerLayout;
};

export function installDualPaneScrollHooks(): void {
	(
		globalThis as { __agenteroPdfScroll?: AgenteroPdfScrollHooks }
	).__agenteroPdfScroll = {
		sameScrollerLayout,
	};
}

installDualPaneScrollHooks();
