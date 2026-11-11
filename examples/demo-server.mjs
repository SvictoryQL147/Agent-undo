#!/usr/bin/env node
// A tiny MCP server with no dependencies, for demos and tests.
// Tools: read_file, write_file, delete_file, send_email (fake, never sends anything).
// Usage: node demo-server.mjs <folder>
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const safe = (p) => {
  const abs = resolve(root, p);
  if (relative(root, abs).startsWith("..")) throw new Error("path escapes root");
  return abs;
};

const tools = [
  { name: "read_file", description: "Read a text file", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a text file", annotations: { destructiveHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "delete_file", description: "Delete a file", annotations: { destructiveHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "send_email", description: "Send an email (demo: does nothing)", annotations: { openWorldHint: true },
    inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" } }, required: ["to"] } },
];

const handlers = {
  read_file: ({ path }) => readFileSync(safe(path), "utf8"),
  write_file: ({ path, content }) => {
    const abs = safe(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return `wrote ${path}`;
  },
  delete_file: ({ path }) => (rmSync(safe(path)), `deleted ${path}`),
  send_email: ({ to, subject }) => `pretended to email ${to}: ${subject ?? ""}`,
};

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-undo-demo", version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      const fn = handlers[msg.params?.name];
      if (!fn) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool" } });
      try {
        return reply({ content: [{ type: "text", text: fn(msg.params.arguments ?? {}) }] });
      } catch (e) {
        return reply({ isError: true, content: [{ type: "text", text: e.message }] });
      }
    }
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
