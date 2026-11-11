import { spawn } from "node:child_process";
import { join } from "node:path";
import { classify, type ToolAnnotations } from "./classify.js";
import type { Config } from "./config.js";
import { idKey, isResponse, readMessages, writeMessage, writeRaw, type JsonRpcMessage } from "./jsonrpc.js";
import { ActionLog } from "./log.js";
import { SnapshotStore } from "./snapshot.js";

const log = (...a: unknown[]) => process.stderr.write(`[agent-undo] ${a.join(" ")}\n`);

interface InFlight {
  stepId: number | null;
  settle: () => void;
}

/**
 *   agent (MCP client) ⇄ [ this proxy ] ⇄ real MCP server (child process)
 *
 * Everything is passed through untouched except `tools/call`, which is:
 *   classify → (wait for earlier writes) → snapshot → forward → record result
 * The agent never knows the proxy is there.
 */
export async function runProxy(command: string[], cfg: Config): Promise<void> {
  if (command.length === 0) throw new Error("No server command given. Usage: agent-undo wrap -- <command> [args...]");

  const store = new SnapshotStore(cfg.root, cfg.dataDir);
  await store.init();
  const actions = new ActionLog(join(cfg.dataDir, "log.db"));

  const child = spawn(command[0], command.slice(1), {
    stdio: ["pipe", "pipe", "inherit"],
    shell: process.platform === "win32",
  });
  child.on("error", (e) => {
    log("failed to start server:", e.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    actions.close();
    process.exit(code ?? (signal ? 1 : 0));
  });

  const annotations = new Map<string, ToolAnnotations | undefined>(); // tool name → hints
  const pendingToolLists = new Set<string>(); // ids of tools/list requests
  const inflight = new Map<string, InFlight>(); // ids of tools/call requests
  const writesInFlight = new Set<Promise<void>>();
  let queue: Promise<void> = Promise.resolve(); // tools/call are handled strictly in order

  // ── agent → server ────────────────────────────────────────────────
  readMessages(process.stdin, (msg, raw) => {
    if (!msg || Array.isArray(msg)) return writeRaw(child.stdin, raw);

    if (msg.method === "tools/list" && msg.id != null) pendingToolLists.add(idKey(msg.id));

    if (msg.method === "notifications/cancelled") {
      const f = inflight.get(idKey(msg.params?.requestId));
      if (f) {
        if (f.stepId) actions.finish(f.stepId, "cancelled");
        f.settle();
      }
    }

    if (msg.method === "tools/call" && msg.id != null) {
      queue = queue.then(() => handleToolCall(msg)).catch((e) => {
        log("error handling tool call:", (e as Error).message);
        writeMessage(child.stdin, msg); // never swallow the agent's request
      });
      return;
    }

    // Everything else (initialize, notifications, responses to server requests…) passes straight through,
    // so a server asking the client something mid-call can never deadlock behind the queue.
    writeRaw(child.stdin, raw);
  });
  process.stdin.on("end", () => child.stdin.end());

  // ── server → agent ────────────────────────────────────────────────
  readMessages(child.stdout, (msg, raw) => {
    if (msg && !Array.isArray(msg) && isResponse(msg)) {
      const key = idKey(msg.id);
      if (pendingToolLists.delete(key) && Array.isArray(msg.result?.tools)) {
        for (const t of msg.result.tools) annotations.set(t.name, t.annotations);
      }
      const f = inflight.get(key);
      if (f) {
        if (f.stepId) recordResult(f.stepId, msg);
        f.settle();
      }
    }
    writeRaw(process.stdout, raw);
  });

  async function handleToolCall(msg: JsonRpcMessage): Promise<void> {
    const name: string = msg.params?.name ?? "(unknown)";
    const args = msg.params?.arguments ?? {};
    const kind = classify(name, annotations.get(name), cfg);
    const key = idKey(msg.id);

    if (kind === "read") {
      const stepId = cfg.logReads ? actions.begin(name, args, kind) : null;
      track(key, stepId, false);
      writeMessage(child.stdin, msg);
      return;
    }

    // Wait for earlier side-effecting calls to finish so snapshots never capture half-written state.
    if (writesInFlight.size) await Promise.all(writesInFlight);

    const stepId = actions.begin(name, args, kind);
    try {
      const hash = await store.snapshot(`pre #${stepId} ${name}`);
      actions.setSnapshot(stepId, hash);
    } catch (e) {
      log(`snapshot failed for #${stepId} (${name}), continuing without one:`, (e as Error).message);
    }

    if (kind === "external" && cfg.guard === "block") {
      actions.finish(stepId, "blocked", "Blocked by agent-undo guard (external action)");
      writeMessage(process.stdout, {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: `agent-undo blocked "${name}": it affects the outside world and cannot be undone. ` +
                `Ask the user to allow it (set "guard": "log" or add "${name}" to "tools" in undo.config.json).`,
            },
          ],
        },
      });
      return;
    }

    track(key, stepId, true);
    writeMessage(child.stdin, msg);
  }

  function track(key: string, stepId: number | null, isWrite: boolean): void {
    let settle!: () => void;
    const done = new Promise<void>((r) => (settle = r));
    inflight.set(key, {
      stepId,
      settle: () => {
        inflight.delete(key);
        settle();
      },
    });
    if (isWrite) {
      writesInFlight.add(done);
      done.then(() => writesInFlight.delete(done));
    }
  }

  function recordResult(stepId: number, msg: JsonRpcMessage): void {
    if (msg.error) return actions.finish(stepId, "failed", msg.error.message);
    const text = Array.isArray(msg.result?.content)
      ? msg.result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ")
      : "";
    actions.finish(stepId, msg.result?.isError ? "failed" : "done", text.slice(0, 300) || null as any);
  }

  log(`watching ${cfg.root} (guard: ${cfg.guard})`);
}
