import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_ENV_FILE = ".env";

/**
 * Loads KEY=VALUE pairs from a dotenv file into process.env.
 * Does not override variables that are already set. Missing files are a no-op.
 * Values are never logged.
 */
export function loadDotEnv(filePath: string = process.env.RELEASE_OPERATOR_ENV_FILE ?? DEFAULT_ENV_FILE): string | undefined {
  const path = resolve(filePath);
  if (!existsSync(path)) return undefined;
  applyEnv(parseDotEnv(readFileSync(path, "utf8")));
  return path;
}

export function parseDotEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = unquote(withoutExport.slice(eq + 1).trim());
  }
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const start = value[0];
    const end = value[value.length - 1];
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      const inner = value.slice(1, -1);
      if (start === '"') {
        return inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      return inner;
    }
  }
  const comment = value.search(/\s+#/);
  let v = (comment === -1 ? value : value.slice(0, comment)).trim();
  // Unmatched wrapping quotes from copy-paste (e.g. secret...")
  if (v.startsWith('"') && !v.endsWith('"')) v = v.slice(1);
  if (v.endsWith('"') && !v.startsWith('"')) v = v.slice(0, -1);
  if (v.startsWith("'") && !v.endsWith("'")) v = v.slice(1);
  if (v.endsWith("'") && !v.startsWith("'")) v = v.slice(0, -1);
  return v.trim();
}

function applyEnv(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
