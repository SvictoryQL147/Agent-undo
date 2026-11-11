#!/usr/bin/env node
// A scripted "overeager agent" for demos: asked to tidy up, it deletes your work.
// Every action is a real MCP tool call sent through the agent-undo proxy to examples/demo-server.mjs.
// Usage: node examples/demo-agent.mjs <folder>
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
const server = join(here, "demo-server.mjs");
const root = resolve(process.argv[2] ?? process.cwd());

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c(2), magenta = c(35), cyan = c(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proxy = spawn("node", [cli, "wrap", "--root", root, "--", "node", server, root], {
  stdio: ["pipe", "pipe", "ignore"],
});
const waiting = new Map();
createInterface({ input: proxy.stdout }).on("line", (l) => {
  const m = JSON.parse(l);
  waiting.get(m.id)?.(m);
});
let nextId = 1;
const call = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    waiting.set(id, res);
    proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo-agent", version: "0" } });
await call("tools/list", {});

console.log(magenta("● agent:") + " Sure! Tidying up the project…");
const plan = [
  ["delete_file", { path: "notes.md" }],
  ["delete_file", { path: "app.js" }],
  ["write_file", { path: "README.md", content: "# Project\n\nAll clean!\n" }],
];
for (const [name, args] of plan) {
  await sleep(250);
  await call("tools/call", { name, arguments: args });
  console.log(`  ${cyan("⏺")} ${name}(${dim(args.path)})`);
}
console.log(magenta("● agent:") + " Done! Removed 2 unused files. ✨");
proxy.stdin.end();
