import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** One MCP / JSON-RPC 2.0 message. MCP stdio transport = one JSON object per line. */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Read newline-delimited JSON-RPC messages from a stream.
 * `msg` is null when a line isn't valid JSON — the caller should forward `raw` untouched.
 */
export function readMessages(
  stream: Readable,
  onMessage: (msg: JsonRpcMessage | null, raw: string) => void,
): void {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage | null = null;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = null;
    }
    onMessage(msg, line);
  });
}

export function writeMessage(stream: Writable, msg: unknown): void {
  stream.write(JSON.stringify(msg) + "\n");
}

export function writeRaw(stream: Writable, raw: string): void {
  stream.write(raw + "\n");
}

/** Stable map key for a JSON-RPC id (ids may be numbers or strings). */
export function idKey(id: string | number | null | undefined): string {
  return `${typeof id}:${String(id)}`;
}

export function isRequest(m: JsonRpcMessage): boolean {
  return typeof m.method === "string" && m.id !== undefined && m.id !== null;
}

export function isResponse(m: JsonRpcMessage): boolean {
  return m.method === undefined && m.id !== undefined && m.id !== null;
}
