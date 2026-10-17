/**
 * Install the hooks the EmbedPDF scroll and tiling patches call.
 * Importing this module is enough; both PDF viewer entries do that.
 */

import { sameScrollerLayout } from "@/lib/pdf/scroller-layout";
import {
	noteTileBitmapDocument,
	tileBitmapShareKey,
	tileBlobs,
	tileUrls,
} from "@/lib/pdf/tile-bitmap-cache";

export type AgenteroPdfScrollHooks = {
	tileBitmapShareKey: typeof tileBitmapShareKey;
	tileBlobs: typeof tileBlobs;
	tileUrls: typeof tileUrls;
	sameScrollerLayout: typeof sameScrollerLayout;
};

export function installDualPaneScrollHooks(): void {
	(
		globalThis as { __agenteroPdfScroll?: AgenteroPdfScrollHooks }
	).__agenteroPdfScroll = {
		tileBitmapShareKey,
		tileBlobs,
		tileUrls,
		sameScrollerLayout,
	};
}

installDualPaneScrollHooks();

export { noteTileBitmapDocument };
