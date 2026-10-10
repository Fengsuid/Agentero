/**
 * Add-to-chat tail shared by every selection surface (PDF viewer, plaza
 * feed, proxied web papers, text editor): publish the selection as the live
 * Agent chip, pin it, and focus the Agent rail. Surfaces keep their own
 * dismissal / selection-clearing choreography before calling this.
 */

import { presentAgentComposer } from "@/lib/agent/composer-focus";
import {
	type PublishSelectionInput,
	pinActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";

export function addSelectionToChat(payload: PublishSelectionInput): void {
	publishSelection(payload);
	pinActiveSelection();
	presentAgentComposer();
}
