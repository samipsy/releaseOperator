import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ReleaseEngine } from "../src/engine.js";
import { ReleaseStore } from "../src/store.js";
import {
  latestNonCancelledRelease,
  parseStatusFilter,
  resolveEventCommandArgs,
  resolveEventType,
  resolveReleaseIdForEvent,
} from "../src/cli/releaseSelect.js";
import type { Release } from "../src/types.js";

function release(overrides: Partial<Release> & Pick<Release, "id" | "state">): Release {
  const now = new Date();
  return {
    version: "1.0.0",
    repos: [{ name: "web", sourceBranch: "develop" }],
    environment: "prod",
    approvals: {},
    ci: { status: "unknown" },
    featureFlags: [],
    createdBy: "sam",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("parseStatusFilter", () => {
  it("parses comma-separated states", () => {
    expect(parseStatusFilter("cancelled, DRAFT")).toEqual(["CANCELLED", "DRAFT"]);
  });

  it("rejects unknown states", () => {
    expect(() => parseStatusFilter("DONE")).toThrow(/Unknown status/);
  });
});

describe("resolveEventType", () => {
  it("maps imperative CLI actions onto engine events", () => {
    expect(resolveEventType("create_branch")).toBe("BRANCHES_CREATED");
    expect(resolveEventType("CREATE-BRANCH")).toBe("BRANCHES_CREATED");
    expect(resolveEventType("create_ticket")).toBe("TICKET_CREATED");
    expect(resolveEventType("change_applied")).toBe("CHANGE_APPLIED");
    expect(resolveEventType("approve_cab")).toBe("CAB_APPROVED");
    expect(resolveEventType("cancel")).toBe("CANCELLED");
  });

  it("still accepts canonical engine event names", () => {
    expect(resolveEventType("BRANCHES_CREATED")).toBe("BRANCHES_CREATED");
    expect(resolveEventType("branches_created")).toBe("BRANCHES_CREATED");
  });
});

describe("resolveEventCommandArgs", () => {
  it("treats a single argument as the event type", () => {
    expect(resolveEventCommandArgs("CREATE_BRANCH", undefined)).toEqual({
      eventType: "BRANCHES_CREATED",
    });
  });

  it("treats two arguments as id then event", () => {
    expect(resolveEventCommandArgs("rel-1", "TICKET_CREATED")).toEqual({
      releaseId: "rel-1",
      eventType: "TICKET_CREATED",
    });
  });
});

describe("latestNonCancelledRelease", () => {
  it("skips cancelled records and picks the newest remaining", () => {
    const cancelled = release({ id: "old", state: "CANCELLED" });
    const draft = release({ id: "new", state: "DRAFT" });
    expect(latestNonCancelledRelease([cancelled, draft])?.id).toBe("new");
    expect(resolveReleaseIdForEvent([cancelled, draft])).toBe("new");
    expect(resolveReleaseIdForEvent([cancelled, draft], "old")).toBe("old");
  });
});

describe("ReleaseEngine.deleteReleasesInStates", () => {
  it("removes matching releases and their event log", () => {
    const store = new ReleaseStore(openDb(":memory:"));
    const engine = new ReleaseEngine(store);
    const keep = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "develop" }],
      environment: "prod",
      createdBy: "sam",
    });
    const drop = engine.createRelease({
      version: "1.0.1",
      repos: [{ name: "web", sourceBranch: "develop" }],
      environment: "prod",
      createdBy: "sam",
    });
    void engine.transition(drop.id, { type: "CANCELLED", actor: "sam" });

    const deleted = engine.deleteReleasesInStates(["CANCELLED"]);
    expect(deleted.map((r) => r.id)).toEqual([drop.id]);
    expect(engine.listReleases().map((r) => r.id)).toEqual([keep.id]);
    expect(engine.getHistory(drop.id)).toEqual([]);
  });
});
