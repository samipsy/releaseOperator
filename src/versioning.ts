export type ReleaseBump = "major" | "minor" | "patch";

const SEMVER = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i;

export function parseReleaseBump(raw: string): ReleaseBump {
  const value = raw.trim().toLowerCase();
  if (value === "major" || value === "minor" || value === "patch") return value;
  throw new Error(`Release type must be major, minor, or patch (got "${raw}").`);
}

export function parsePackageVersion(raw: string): { major: number; minor: number; patch: number } {
  const match = raw.trim().match(SEMVER);
  if (!match) {
    throw new Error(`package.json version "${raw}" is not major.minor.patch (e.g. 1.2.3).`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Next release version from the current package.json version and bump type. Prerelease suffixes are dropped. */
export function nextVersionFromPackage(current: string, bump: ReleaseBump): string {
  const parsed = parsePackageVersion(current);
  if (bump === "major") return `${parsed.major + 1}.0.0`;
  if (bump === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/** Set package.json "version" while keeping indent and a trailing newline when present. */
export function applyPackageJsonVersion(
  text: string,
  version: string
): { text: string; previous: string | undefined; changed: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`package.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("package.json is not a JSON object.");
  }
  const rec = parsed as Record<string, unknown>;
  const previous = typeof rec.version === "string" ? rec.version : undefined;
  if (previous === version) return { text, previous, changed: false };

  const replaced = text.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${version}$3`);
  try {
    const check = JSON.parse(replaced) as Record<string, unknown>;
    if (check.version === version) return { text: replaced, previous, changed: true };
  } catch {
    // fall through to stringify
  }

  rec.version = version;
  const indentMatch = text.match(/\n( +)"/);
  const indent = indentMatch ? indentMatch[1].length : 2;
  const trailing = /\n\s*$/.test(text) ? "\n" : "";
  return { text: `${JSON.stringify(rec, null, indent)}${trailing}`, previous, changed: true };
}
