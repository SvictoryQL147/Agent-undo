import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * File snapshots backed by a *separate* hidden git repo in .undo/repo.
 * It never touches the user's own .git — GIT_DIR points elsewhere, GIT_WORK_TREE is the root.
 * Files ignored by the project's .gitignore are not snapshotted (and never deleted on rollback).
 */
export class SnapshotStore {
  readonly gitDir: string;

  constructor(readonly root: string, dataDir: string) {
    this.gitDir = join(dataDir, "repo");
  }

  private git(args: string[]): Promise<string> {
    const env = {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.root,
      GIT_AUTHOR_NAME: "agent-undo",
      GIT_AUTHOR_EMAIL: "agent-undo@localhost",
      GIT_COMMITTER_NAME: "agent-undo",
      GIT_COMMITTER_EMAIL: "agent-undo@localhost",
    };
    const base = ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.quotepath=false"];
    return new Promise((resolve, reject) => {
      execFile("git", [...base, ...args], { cwd: this.root, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
        else resolve(stdout);
      });
    });
  }

  async init(): Promise<void> {
    if (existsSync(join(this.gitDir, "HEAD"))) return;
    mkdirSync(this.gitDir, { recursive: true });
    await this.git(["init", "-q"]);
    await this.git(["config", "gc.auto", "0"]);
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(
      join(this.gitDir, "info", "exclude"),
      ["/.undo/", ".git/", "node_modules/", ".DS_Store", ""].join("\n"),
    );
    await this.snapshot("baseline");
  }

  /** Commit the current state of the root. Returns the commit hash. */
  async snapshot(label: string): Promise<string> {
    await this.git(["add", "-A"]);
    await this.git(["commit", "-q", "--allow-empty", "--no-verify", "-m", label]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  /**
   * Make the working tree look exactly like `hash`.
   * read-tree --reset -u also deletes files that exist now but didn't exist at `hash`.
   * HEAD is not moved, so history stays linear and the rollback itself can be undone.
   */
  async restore(hash: string): Promise<void> {
    await this.git(["add", "-A"]);
    await this.git(["read-tree", "-u", "--reset", hash]);
  }

  /** Patch + stat between two snapshots, or between a snapshot and the current files. */
  async diff(from: string, to?: string): Promise<string> {
    if (to) return this.git(["diff", "--stat", "-p", from, to]);
    await this.git(["add", "-A"]);
    return this.git(["diff", "--cached", "--stat", "-p", from]);
  }

  /** e.g. [{status:"D", path:"notes.txt"}] */
  async changedFiles(from: string, to?: string): Promise<{ status: string; path: string }[]> {
    let out: string;
    if (to) out = await this.git(["diff", "--name-status", from, to]);
    else {
      await this.git(["add", "-A"]);
      out = await this.git(["diff", "--cached", "--name-status", from]);
    }
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [status, ...rest] = l.split("\t");
        return { status, path: rest.join("\t") };
      });
  }
}
