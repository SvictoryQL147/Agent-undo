#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning; keep the CLI output clean.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});

import { parseArgs } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const HELP = `agent-undo — Ctrl+Z for AI agents

Usage:
  agent-undo wrap [--root <dir>] [--guard log|block] -- <mcp server command...>
      Run an MCP server behind the undo proxy. Put this in your MCP client config.

  agent-undo list [-n 20]          Timeline of what the agent did
  agent-undo show <step>           Details of one step
  agent-undo diff <step>           What a step changed on disk
  agent-undo rollback <step> [-y]  Restore files to just before <step>
  agent-undo last [-y]             Undo the most recent step

Options:
  --root <dir>   Folder the agent works in (default: current folder)
  -y, --yes      Don't ask for confirmation
`;

const c = (code: number) => (s: string | number) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36), bold = c(1);

async function main() {
  const argv = process.argv.slice(2);
  const dashdash = argv.indexOf("--");
  const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
  const serverCmd = dashdash === -1 ? [] : argv.slice(dashdash + 1);

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      guard: { type: "string" },
      n: { type: "string", short: "n" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || values.help) return console.log(HELP);

  const { loadConfig, findRoot } = await import("./config.js");

  if (cmd === "wrap") {
    const guard = values.guard as "log" | "block" | undefined;
    if (guard && guard !== "log" && guard !== "block") throw new Error("--guard must be 'log' or 'block'");
    const cfg = loadConfig(values.root ?? process.cwd(), { guard });
    const { runProxy } = await import("./proxy.js");
    return runProxy(serverCmd, cfg);
  }

  const root = values.root ?? findRoot(process.cwd());
  const cfg = loadConfig(root);
  const dbPath = join(cfg.dataDir, "log.db");
  if (!existsSync(dbPath)) throw new Error(`No agent-undo history in ${cfg.root}. Run your agent through 'agent-undo wrap' first.`);

  const { ActionLog } = await import("./log.js");
  const { SnapshotStore } = await import("./snapshot.js");
  const { planRollback, rollback } = await import("./rollback.js");
  const log = new ActionLog(dbPath);
  const store = new SnapshotStore(cfg.root, cfg.dataDir);

  const stepArg = () => {
    const id = Number(arg);
    if (!Number.isInteger(id) || id < 1) throw new Error(`Expected a step number, got '${arg ?? ""}'`);
    return id;
  };

  switch (cmd) {
    case "list": {
      const steps = log.list(Number(values.n ?? 20));
      if (!steps.length) return console.log(dim("No steps recorded yet."));
      for (const s of steps) {
        const kindTag =
          s.kind === "external" ? red("external") : s.kind === "rollback" ? cyan("rollback") : s.kind === "read" ? dim("read    ") : yellow("write   ");
        const status =
          s.status === "done" ? green("✓") : s.status === "rolled_back" ? dim("↺") : s.status === "failed" ? red("✗") : s.status === "blocked" ? red("⛔") : dim("…");
        const time = new Date(s.ts).toLocaleTimeString();
        const line = `${status} ${bold(String(s.id).padStart(3))}  ${dim(time)}  ${kindTag}  ${s.tool}  ${dim(short(s.args, 50))}`;
        console.log(s.status === "rolled_back" ? dim(line.replace(/\x1b\[[0-9;]*m/g, "")) : line);
      }
      console.log(dim(`\n↺ = rolled back   undo with: agent-undo rollback <step>`));
      return;
    }

    case "show": {
      const s = log.get(stepArg());
      if (!s) throw new Error(`Step #${arg} not found`);
      console.log(`${bold(`#${s.id}`)} ${s.tool}  (${s.kind}, ${s.status})`);
      console.log(`${dim("time:")}     ${s.ts}`);
      console.log(`${dim("args:")}     ${JSON.stringify(JSON.parse(s.args), null, 2)}`);
      console.log(`${dim("snapshot:")} ${s.snapshot ?? "none"}`);
      if (s.summary) console.log(`${dim("result:")}   ${s.summary}`);
      return;
    }

    case "diff": {
      const s = log.get(stepArg());
      if (!s?.snapshot) throw new Error(`Step #${arg} has no snapshot (read-only or not found)`);
      const next = log.nextSnapshotAfter(s.id);
      const out = await store.diff(s.snapshot, next?.snapshot ?? undefined);
      console.log(out.trim() || dim("No file changes."));
      return;
    }

    case "rollback":
    case "last": {
      const id = cmd === "last" ? log.lastUndoable()?.id : stepArg();
      if (!id) return console.log(dim("Nothing to undo."));
      const plan = await planRollback(id, log, store);

      console.log(bold(`Roll back to just before step #${plan.target.id} (${plan.target.tool})`));
      console.log(`  ${plan.steps.length} step(s) reverted, ${plan.files.length} file(s) change:`);
      for (const f of plan.files.slice(0, 15)) console.log(`    ${fileVerb(f.status)} ${f.path}`);
      if (plan.files.length > 15) console.log(dim(`    …and ${plan.files.length - 15} more`));
      for (const s of plan.irreversible) {
        console.log(red(`  ⚠ #${s.id} ${s.tool} reached the outside world and can't be undone.`));
      }

      if (!values.yes) {
        if (!process.stdin.isTTY) throw new Error("Refusing to roll back without confirmation. Re-run with --yes.");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ans = await rl.question("Proceed? [y/N] ");
        rl.close();
        if (!/^y(es)?$/i.test(ans.trim())) return console.log("Cancelled.");
      }

      const res = await rollback(id, log, store);
      console.log(green(`✓ Done. Recorded as step #${res.rollbackStep}; undo it with: agent-undo rollback ${res.rollbackStep}`));
      return;
    }

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

function fileVerb(status: string) {
  // status is from "snapshot → now", so invert it to describe what rollback does
  if (status.startsWith("A")) return red("delete ");
  if (status.startsWith("D")) return green("restore");
  return yellow("revert ");
}

function short(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

main().catch((e) => {
  console.error(red(`error: ${(e as Error).message}`));
  process.exit(1);
});
