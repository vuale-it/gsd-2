// GSD-2 + src/resources/extensions/gsd/auto/unit-runner-events.ts - Classifies agent lifecycle events before Unit settlement.

import type { AgentEndEvent } from "./types.js";

export function isInternalSessionTransitionAbortEvent(
  event: Pick<AgentEndEvent, "abortOrigin">,
): boolean {
  return event.abortOrigin === "session-transition";
}

export function shouldIgnoreAgentEndForActiveUnit(
  event: Pick<AgentEndEvent, "abortOrigin">,
): boolean {
  return isInternalSessionTransitionAbortEvent(event);
}
