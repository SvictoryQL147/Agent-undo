import type { ActionLog, Step } from "./log.js";
import type { SnapshotStore } from "./snapshot.js";

export interface RollbackPlan {
  target: Step;
  /** Steps that will be reverted (target and everything after it). */
  steps: Step[];
  /** Steps that touched the outside world. Rolling back can't un-send them. */
  irreversible: Step[];
  files: { status: string; path: string }[];
}

/** Work out what rolling back to step `id` would do, without changing anything. */
export async function planRollback(id: number, log: ActionLog, store: SnapshotStore): Promise<RollbackPlan> {
  const target = log.firstSnapshotFrom(id);
  if (!target?.snapshot) throw new Error(`No snapshot found at or after step #${id}.`);
  const steps = log.activeSince(target.id);
  const irreversible = steps.filter((s) => s.kind === "external" && s.status === "done");
  const files = await store.changedFiles(target.snapshot);
  return { target, steps, irreversible, files };
}

/**
 * Restore the files to how they were right BEFORE step `id` ran.
 * A safety snapshot is taken first and recorded as its own step,
 * so the rollback itself shows up in the timeline and can be undone.
 */
export async function rollback(id: number, log: ActionLog, store: SnapshotStore): Promise<RollbackPlan & { rollbackStep: number }> {
  const plan = await planRollback(id, log, store);
  const rollbackStep = log.begin(`rollback → #${plan.target.id}`, { to: plan.target.id }, "rollback");
  const safety = await store.snapshot(`pre-rollback-to-${plan.target.id}`);
  log.setSnapshot(rollbackStep, safety);

  await store.restore(plan.target.snapshot!);

  log.markRolledBack(plan.steps.map((s) => s.id));
  log.finish(
    rollbackStep,
    "done",
    `Reverted ${plan.steps.length} step(s), ${plan.files.length} file(s) restored`,
  );
  return { ...plan, rollbackStep };
}
