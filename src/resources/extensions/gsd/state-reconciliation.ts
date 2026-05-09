// Project/App: GSD-2
// File Purpose: ADR-015 State Reconciliation module for pre-dispatch runtime invariants.

import { deriveState, invalidateStateCache, type DeriveStateOptions } from "./state.js";
import type { GSDState } from "./types.js";

export type StateReconciliationResult =
  | {
      ok: true;
      stateSnapshot: GSDState;
      repaired: readonly string[];
      blockers: readonly string[];
    }
  | {
      ok: false;
      reason: string;
      stateSnapshot?: GSDState;
      repaired: readonly string[];
      blockers: readonly string[];
    };

export interface StateReconciliationDeps {
  invalidateStateCache: () => void;
  deriveState: (basePath: string, opts?: DeriveStateOptions) => Promise<GSDState>;
}

const defaultDeps: StateReconciliationDeps = {
  invalidateStateCache,
  deriveState,
};

export async function reconcileBeforeDispatch(
  basePath: string,
  deps: StateReconciliationDeps = defaultDeps,
  opts?: DeriveStateOptions,
): Promise<StateReconciliationResult> {
  deps.invalidateStateCache();
  const stateSnapshot = await deps.deriveState(basePath, opts);
  const blockers = stateSnapshot.blockers ?? [];

  if (blockers.length > 0 || stateSnapshot.phase === "blocked") {
    return {
      ok: false,
      reason: blockers[0] ?? `State reconciliation blocked in phase ${stateSnapshot.phase}`,
      stateSnapshot,
      repaired: ["derive-state-cache-invalidated"],
      blockers,
    };
  }

  return {
    ok: true,
    stateSnapshot,
    repaired: ["derive-state-cache-invalidated"],
    blockers,
  };
}
