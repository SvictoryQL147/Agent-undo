import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

/**
 * read      – no side effects, forwarded without a snapshot
 * write     – changes local state, snapshot taken first (reversible)
 * external  – touches the outside world (email, payments, HTTP POST…); cannot be truly undone
 */
export type Kind = "read" | "write" | "external";

export interface Config {
  /** Directory whose files are snapshotted (the folder your agent works in). */
  root: string;
  /** Where agent-undo keeps its snapshot repo + action log. Default: <root>/.undo */
  dataDir: string;
  /** What to do with `external` calls: just log them, or block them. */
  guard: "log" | "block";
  /** Record read-only calls in the log too (noisy, off by default). */
  logReads: boolean;
  /** Per-tool overrides, e.g. { "run_sql": "write", "send_invoice": "external" } */
  tools: Record<string, Kind>;
}

export const CONFIG_FILE = "undo.config.json";

export function loadConfig(root: string, overrides: Partial<Config> = {}): Config {
  const absRoot = resolve(root);
  let fileCfg: Partial<Config> = {};
  const path = join(absRoot, CONFIG_FILE);
  if (existsSync(path)) {
    try {
      fileCfg = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`Could not parse ${path}: ${(e as Error).message}`);
    }
  }
  const merged: Config = {
    root: absRoot,
    dataDir: join(absRoot, ".undo"),
    guard: "log",
    logReads: false,
    tools: {},
    ...fileCfg,
    ...stripUndefined(overrides),
  };
  merged.root = absRoot;
  merged.dataDir = resolve(absRoot, merged.dataDir);
  return merged;
}

/** Walk up from `start` to find a folder that already has a .undo directory. */
export function findRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".undo", "log.db"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
