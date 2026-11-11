import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Kind } from "./config.js";

export type StepKind = Kind | "rollback";
export type StepStatus = "pending" | "done" | "failed" | "blocked" | "cancelled" | "rolled_back";

export interface Step {
  id: number;
  ts: string;
  tool: string;
  args: string;
  kind: StepKind;
  /** Snapshot of the files taken BEFORE this step ran. */
  snapshot: string | null;
  status: StepStatus;
  summary: string | null;
}

/** Append-only timeline of everything the agent did. SQLite (built into Node) in WAL mode,
 *  so the CLI can read it while the proxy is writing. */
export class ActionLog {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS steps (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT NOT NULL,
        tool     TEXT NOT NULL,
        args     TEXT NOT NULL,
        kind     TEXT NOT NULL,
        snapshot TEXT,
        status   TEXT NOT NULL,
        summary  TEXT
      );
    `);
  }

  begin(tool: string, args: unknown, kind: StepKind): number {
    const r = this.db
      .prepare("INSERT INTO steps (ts, tool, args, kind, status) VALUES (?, ?, ?, ?, 'pending')")
      .run(new Date().toISOString(), tool, JSON.stringify(args ?? {}), kind);
    return Number(r.lastInsertRowid);
  }

  setSnapshot(id: number, hash: string): void {
    this.db.prepare("UPDATE steps SET snapshot = ? WHERE id = ?").run(hash, id);
  }

  finish(id: number, status: StepStatus, summary?: string): void {
    this.db.prepare("UPDATE steps SET status = ?, summary = ? WHERE id = ?").run(status, summary ?? null, id);
  }

  get(id: number): Step | undefined {
    return this.db.prepare("SELECT * FROM steps WHERE id = ?").get(id) as Step | undefined;
  }

  list(limit = 20): Step[] {
    const rows = this.db.prepare("SELECT * FROM steps ORDER BY id DESC LIMIT ?").all(limit) as unknown as Step[];
    return rows.reverse();
  }

  /** Steps from `id` onwards that changed (or may have changed) something. */
  activeSince(id: number): Step[] {
    return this.db
      .prepare("SELECT * FROM steps WHERE id >= ? AND kind != 'read' AND status != 'rolled_back' ORDER BY id")
      .all(id) as unknown as Step[];
  }

  /** First snapshot taken at or after `id` (rolling back to a read-only step uses the next one). */
  firstSnapshotFrom(id: number): Step | undefined {
    return this.db
      .prepare("SELECT * FROM steps WHERE id >= ? AND snapshot IS NOT NULL ORDER BY id LIMIT 1")
      .get(id) as Step | undefined;
  }

  /** The next snapshot after `id` — i.e. the state right after step `id` finished. */
  nextSnapshotAfter(id: number): Step | undefined {
    return this.db
      .prepare("SELECT * FROM steps WHERE id > ? AND snapshot IS NOT NULL ORDER BY id LIMIT 1")
      .get(id) as Step | undefined;
  }

  /** Most recent step that can be undone. */
  lastUndoable(): Step | undefined {
    return this.db
      .prepare(
        "SELECT * FROM steps WHERE snapshot IS NOT NULL AND status NOT IN ('rolled_back','blocked') ORDER BY id DESC LIMIT 1",
      )
      .get() as Step | undefined;
  }

  markRolledBack(ids: number[]): void {
    const stmt = this.db.prepare("UPDATE steps SET status = 'rolled_back' WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  close(): void {
    this.db.close();
  }
}
