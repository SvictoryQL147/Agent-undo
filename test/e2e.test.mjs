// End-to-end: agent → agent-undo proxy → demo server, then roll back with the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "dist", "cli.js");
const server = join(repo, "examples", "demo-server.mjs");

function startProxy(root, extra = []) {
  const p = spawn("node", [cli, "wrap", "--root", root, ...extra, "--", "node", server, root], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  createInterface({ input: p.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((res) => {
      const id = nextId++;
      waiting.set(id, res);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const tool = (name, args) => call("tools/call", { name, arguments: args });
  const stop = () => new Promise((res) => { p.on("exit", res); p.stdin.end(); });
  return { call, tool, stop };
}

const undo = (root, ...args) =>
  execFileSync("node", [cli, ...args, "--root", root], { encoding: "utf8" });

test("records actions and rolls them back", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-undo-"));
  writeFileSync(join(root, "important.txt"), "do not lose me");

  const a = startProxy(root);
  await a.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  await a.call("tools/list", {});

  const r1 = await a.tool("write_file", { path: "notes/plan.md", content: "v1" }); // step 1
  assert.equal(r1.result.content[0].text, "wrote notes/plan.md");
  await a.tool("delete_file", { path: "important.txt" });                         // step 2
  await a.tool("send_email", { to: "boss@example.com", subject: "done" });        // step 3
  const read = await a.tool("read_file", { path: "notes/plan.md" });              // not logged
  assert.equal(read.result.content[0].text, "v1");
  await a.stop();

  assert.equal(existsSync(join(root, "important.txt")), false);

  const list = undo(root, "list");
  assert.match(list, /write_file/);
  assert.match(list, /delete_file/);
  assert.match(list, /send_email/);
  assert.doesNotMatch(list, /read_file/);

  const diff = undo(root, "diff", "2");
  assert.match(diff, /important\.txt/);

  const out = undo(root, "rollback", "1", "--yes");
  assert.match(out, /send_email reached the outside world/);
  assert.equal(readFileSync(join(root, "important.txt"), "utf8"), "do not lose me");
  assert.equal(existsSync(join(root, "notes", "plan.md")), false);

  // The rollback itself is undoable.
  undo(root, "last", "--yes");
  assert.equal(readFileSync(join(root, "notes", "plan.md"), "utf8"), "v1");
  assert.equal(existsSync(join(root, "important.txt")), false);
});

test("guard=block stops external actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-undo-"));
  const a = startProxy(root, ["--guard", "block"]);
  await a.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  await a.call("tools/list", {});
  const r = await a.tool("send_email", { to: "x@example.com" });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /blocked/);
  await a.stop();
  assert.match(undo(root, "list"), /send_email/);
});

test("classifier heuristics", async () => {
  const { classify } = await import(join(repo, "dist", "classify.js"));
  const cfg = { tools: { run_sql: "write" } };
  assert.equal(classify("readFile", undefined, cfg), "read");
  assert.equal(classify("send_slack_message", undefined, cfg), "external");
  assert.equal(classify("edit_file", undefined, cfg), "write");
  assert.equal(classify("mystery_tool", undefined, cfg), "write");
  assert.equal(classify("run_sql", { readOnlyHint: true }, cfg), "write");
  assert.equal(classify("anything", { readOnlyHint: true }, cfg), "read");
});
