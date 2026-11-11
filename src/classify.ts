import type { Config, Kind } from "./config.js";

/** MCP tool annotations (spec 2025-03-26+). All are hints, servers may omit them. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

const EXTERNAL = new Set([
  "send", "email", "mail", "post", "publish", "tweet", "pay", "payment", "charge",
  "refund", "transfer", "invoice", "sms", "notify", "message", "webhook", "deploy",
  "slack", "whatsapp", "submit", "purchase", "order", "book",
]);

const WRITE = new Set([
  "write", "edit", "create", "delete", "remove", "rm", "move", "mv", "rename",
  "update", "insert", "append", "patch", "replace", "mkdir", "save", "apply",
  "set", "put", "drop", "truncate", "run", "exec", "execute", "command", "shell",
  "bash", "commit", "upload", "copy", "cp", "install",
]);

const READ = new Set([
  "read", "get", "list", "search", "find", "query", "fetch", "view", "show",
  "describe", "stat", "info", "tree", "cat", "head", "tail", "ls", "grep", "count",
  "check", "lookup", "inspect", "explain",
]);

/** "sendEmail", "send_email", "files.write-file" → ["send","email"], … */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Decide how a tool call should be treated.
 * Priority: user config → server annotations → name heuristics → default "write"
 * (defaulting to write is the safe choice: an unknown tool gets a snapshot).
 */
export function classify(
  toolName: string,
  annotations: ToolAnnotations | undefined,
  cfg: Pick<Config, "tools">,
): Kind {
  const override = cfg.tools[toolName];
  if (override) return override;

  if (annotations) {
    if (annotations.readOnlyHint === true) return "read";
    if (annotations.openWorldHint === true) return "external";
    if (annotations.destructiveHint !== undefined || annotations.openWorldHint === false) {
      return "write";
    }
  }

  const tokens = tokenize(toolName);
  if (tokens.some((t) => EXTERNAL.has(t))) return "external";
  if (tokens.some((t) => WRITE.has(t))) return "write";
  if (tokens.some((t) => READ.has(t))) return "read";
  return "write";
}
