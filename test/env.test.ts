import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadDotEnv, parseDotEnv } from "../src/env.js";

describe("parseDotEnv", () => {
  it("parses keys, quotes, export, and comments", () => {
    const parsed = parseDotEnv(`
# comment
RELEASE_OPERATOR_JIRA_SITE=https://ipsycorp.atlassian.net
export RELEASE_OPERATOR_JIRA_PROJECT_KEY=PCM
QUOTED="value with spaces"
SINGLE='keep # hash'
INLINE=visible # trailing comment
INVALID LINE
=nosuch
`);
    expect(parsed).toEqual({
      RELEASE_OPERATOR_JIRA_SITE: "https://ipsycorp.atlassian.net",
      RELEASE_OPERATOR_JIRA_PROJECT_KEY: "PCM",
      QUOTED: "value with spaces",
      SINGLE: "keep # hash",
      INLINE: "visible",
    });
  });

  it("strips a stray trailing quote on an unquoted value", () => {
    const parsed = parseDotEnv(`SECRET=abc123"\n`);
    expect(parsed.SECRET).toBe("abc123");
  });
});

describe("loadDotEnv", () => {
  it("sets missing process.env keys and does not override existing ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-dotenv-"));
    const path = join(dir, ".env");
    writeFileSync(path, "RO_TEST_NEW=from-file\nRO_TEST_EXISTING=from-file\n");
    process.env.RO_TEST_EXISTING = "already-set";
    delete process.env.RO_TEST_NEW;

    expect(loadDotEnv(path)).toBe(path);
    expect(process.env.RO_TEST_NEW).toBe("from-file");
    expect(process.env.RO_TEST_EXISTING).toBe("already-set");

    delete process.env.RO_TEST_NEW;
    delete process.env.RO_TEST_EXISTING;
  });

  it("is a no-op when the file is missing", () => {
    expect(loadDotEnv(join(tmpdir(), "does-not-exist.env"))).toBeUndefined();
  });
});
