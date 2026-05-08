// Project/App: GSD-2
// File Purpose: Best-effort unit dispatch claim adapter for auto-mode loop.

import type { AutoSession } from "./session.js";
import type { IterationData } from "./types.js";

export type DispatchClaimOutcome =
  | { kind: "opened"; dispatchId: number }
  | { kind: "skip"; reason: "already-active" | "stale-lease"; existingId?: number; existingWorker?: string }
  | { kind: "degraded" };

export type DispatchLeaseOutcome =
  | { kind: "ready"; token: number; recovered: boolean }
  | { kind: "degraded"; reason: "missing-worker" | "missing-milestone" }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string };

type ClaimMilestoneLeaseResult =
  | { ok: true; token: number; expiresAt: string }
  | { ok: false; error: "held_by"; byWorker: string; expiresAt: string };

interface RecentDispatch {
  attempt_n?: number | null;
}

interface RecordDispatchClaimInput {
  traceId: string;
  turnId?: string | null;
  workerId: string;
  milestoneLeaseToken: number;
  milestoneId: string;
  sliceId?: string | null;
  taskId?: string | null;
  unitType: string;
  unitId: string;
  attemptN?: number;
}

type RecordDispatchClaimResult =
  | { ok: true; dispatchId: number }
  | { ok: false; error: "already_active"; existingId: number; existingWorker: string }
  | { ok: false; error: string; existingId?: number; existingWorker?: string };

export interface OpenDispatchClaimDeps {
  getRecentDispatchesForUnit: (unitId: string, limit: number) => RecentDispatch[];
  recordDispatchClaim: (input: RecordDispatchClaimInput) => RecordDispatchClaimResult;
  markDispatchRunning: (dispatchId: number) => void;
  logClaimRejected: (details: {
    unitId: string;
    reason: string;
    existingId?: number;
    existingWorker?: string;
  }) => void;
  logClaimFailed: (err: unknown) => void;
}

export interface EnsureDispatchLeaseDeps {
  claimMilestoneLease: (workerId: string, milestoneId: string) => ClaimMilestoneLeaseResult;
  logLeaseRecovered: (details: {
    milestoneId: string;
    workerId: string;
    token: number;
    recovered: boolean;
  }) => void;
  logLeaseRecoveryFailed: (details: {
    milestoneId?: string;
    workerId?: string;
    reason: string;
  }) => void;
}

export function ensureDispatchLease(
  s: AutoSession,
  milestoneId: string | undefined,
  deps: EnsureDispatchLeaseDeps,
  opts: { forceReclaim?: boolean } = {},
): DispatchLeaseOutcome {
  if (!s.workerId) return { kind: "degraded", reason: "missing-worker" };
  if (!milestoneId) return { kind: "degraded", reason: "missing-milestone" };
  if (!opts.forceReclaim && typeof s.milestoneLeaseToken === "number") {
    return { kind: "ready", token: s.milestoneLeaseToken, recovered: false };
  }

  s.milestoneLeaseToken = null;
  try {
    const claim = deps.claimMilestoneLease(s.workerId, milestoneId);
    if (!claim.ok) {
      const reason = `Milestone ${milestoneId} is held by worker ${claim.byWorker} until ${claim.expiresAt}.`;
      deps.logLeaseRecoveryFailed({ milestoneId, workerId: s.workerId, reason });
      return { kind: "blocked", reason };
    }

    s.currentMilestoneId = milestoneId;
    s.milestoneLeaseToken = claim.token;
    deps.logLeaseRecovered({
      milestoneId,
      workerId: s.workerId,
      token: claim.token,
      recovered: opts.forceReclaim === true,
    });
    return { kind: "ready", token: claim.token, recovered: opts.forceReclaim === true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.logLeaseRecoveryFailed({ milestoneId, workerId: s.workerId, reason });
    return { kind: "failed", reason };
  }
}

export function openDispatchClaim(
  s: AutoSession,
  flowId: string,
  turnId: string,
  iterData: IterationData,
  deps: OpenDispatchClaimDeps,
): DispatchClaimOutcome {
  if (!s.workerId || typeof s.milestoneLeaseToken !== "number") return { kind: "degraded" };
  const mid = iterData.mid;
  if (!mid) return { kind: "degraded" };

  const recent = deps.getRecentDispatchesForUnit(iterData.unitId, 1);
  const attemptN = (recent[0]?.attempt_n ?? 0) + 1;

  try {
    const claim = deps.recordDispatchClaim({
      traceId: flowId,
      turnId,
      workerId: s.workerId,
      milestoneLeaseToken: s.milestoneLeaseToken,
      milestoneId: mid,
      sliceId: iterData.state.activeSlice?.id ?? null,
      taskId: iterData.state.activeTask?.id ?? null,
      unitType: iterData.unitType,
      unitId: iterData.unitId,
      attemptN,
    });
    if (!claim.ok) {
      deps.logClaimRejected({
        unitId: iterData.unitId,
        reason: claim.error,
        existingId: claim.existingId,
        existingWorker: claim.existingWorker,
      });
      if (claim.error === "already_active") {
        return {
          kind: "skip",
          reason: "already-active",
          existingId: claim.existingId,
          existingWorker: claim.existingWorker,
        };
      }
      return { kind: "skip", reason: "stale-lease" };
    }
    deps.markDispatchRunning(claim.dispatchId);
    return { kind: "opened", dispatchId: claim.dispatchId };
  } catch (err) {
    deps.logClaimFailed(err);
    return { kind: "degraded" };
  }
}
