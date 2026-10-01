import { describe, expect, it } from "vitest";
import {
  PCM_AFFECTED_SERVICE_ARI,
  PCM_CHANGE_LABELS,
  PCM_CHANGE_APPLIED_STATUS,
  PCM_DEFAULT_ROLLBACK_PLAN,
  PCM_MANAGER_APPROVER_ACCOUNT_ID,
  PCM_SLT_APPROVER_ACCOUNT_IDS,
  buildPcmChangeFields,
  changeReasonOneLiner,
  displaySystemName,
  formatPcmTicketDescription,
  isPcmChangeApplied,
  pcmLinkedTicketKeys,
} from "../src/jira/pcmChangeFields.js";
import { toJiraDate, toJiraDateTime } from "../src/jira/plannedWindow.js";
import {
  parseAffectedServices,
  parseServiceRegistryHits,
  resolveAffectedServiceAris,
} from "../src/jira/affectedServices.js";
import type { Release } from "../src/types.js";

function release(overrides?: Partial<Release>): Release {
  const now = new Date();
  return {
    id: "rel-1",
    version: "0.42.0",
    bump: "minor",
    plannedStart: "2026-10-02 10:00",
    plannedEnd: "2026-10-02 11:00",
    affectedServices: ["ari:cloud:graph::service/test/blog"],
    state: "TICKET_CREATE_PENDING",
    repos: [
      {
        name: "blog-microfrontend",
        owner: "ipsy",
        sourceBranch: "develop",
        releaseBranch: "release/0.42.0",
        releasePrUrl: "https://github.com/ipsy/blog-microfrontend/pull/12",
      },
    ],
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

describe("isPcmChangeApplied", () => {
  it("matches the PCM Change Applied status name", () => {
    expect(isPcmChangeApplied(PCM_CHANGE_APPLIED_STATUS)).toBe(true);
    expect(isPcmChangeApplied("change applied")).toBe(true);
    expect(isPcmChangeApplied("CAB Review")).toBe(false);
  });
});

describe("changeReasonOneLiner", () => {
  it("always uses New release, regardless of bump", () => {
    expect(changeReasonOneLiner({ bump: "patch", repo: "blog-microfrontend", version: "0.42.1" })).toBe(
      "New release of blog-microfrontend to 0.42.1"
    );
    expect(changeReasonOneLiner({ bump: "minor", repo: "quiz-microfrontend", version: "0.16.0" })).toBe(
      "New release of quiz-microfrontend to 0.16.0"
    );
    expect(changeReasonOneLiner({ bump: "major", repo: "web", version: "2.0.0" })).toBe("New release of web to 2.0.0");
  });
});

describe("displaySystemName", () => {
  it("turns microfrontend repos into MFE labels", () => {
    expect(displaySystemName("blog-microfrontend")).toBe("Blog MFE");
    expect(displaySystemName("landings")).toBe("Landings MFE");
  });
});

describe("formatPcmTicketDescription", () => {
  it("follows the PCM why / ticket table / env / systems template", () => {
    expect(
      formatPcmTicketDescription({
        version: "0.41.1",
        repo: "landings",
        changes: [
          {
            ticketKey: "EDP-2813",
            ticketUrl: "https://ipsycorp.atlassian.net/browse/EDP-2813",
            title: "Fix the userId being passed to segment.",
            prUrl: "https://github.com/myglam/landings/pull/911",
          },
        ],
      })
    ).toBe(
      [
        "**Why Change is Needed/Change Description:**",
        "",
        "Release v0.41.1 for Landings MFE to address the following tickets",
        "",
        "| Ticket | Description | PRs |",
        "| --- | --- | --- |",
        '| <a href="https://ipsycorp.atlassian.net/browse/EDP-2813"><span style="white-space:nowrap">EDP&#8209;2813</span></a> | Fix the userId being passed to segment. | https://github.com/myglam/landings/pull/911 |',
        "",
        "**Environment(s) Affected:** Prod - US/MX",
        "",
        "**Systems/Applications Impacted:** Landings MFE",
      ].join("\n")
    );
  });
});

describe("pcmLinkedTicketKeys", () => {
  it("dedupes table ticket keys and skips rows without a key", () => {
    expect(
      pcmLinkedTicketKeys([
        { ticketKey: "EDP-2707", title: "Ampli" },
        { ticketKey: "edp-2707", title: "dup" },
        { title: "Backmerge/v1.0.20" },
        { ticketKey: "MET-4170", title: "subscriptions" },
      ])
    ).toEqual(["EDP-2707", "MET-4170"]);
  });
});

describe("buildPcmChangeFields", () => {
  it("fills PCM Change required fields from the release", () => {
    const fields = buildPcmChangeFields(release(), { accountId: "acct-me" });
    expect(fields.customfield_10035).toEqual({ value: "New functionality" });
    expect(fields.customfield_10034).toEqual({ value: "Low" });
    expect(fields.environment).toBeUndefined();
    expect(fields.customfield_10130).toBe("https://github.com/ipsy/blog-microfrontend/pull/12");
    expect(fields.customfield_10486).toBe(
      `${PCM_DEFAULT_ROLLBACK_PLAN}\nUS: https://blog.ipsy.com\nMX: https://blog.ipsy.mx`
    );
    expect(fields.customfield_17017).toBeUndefined();
    expect(fields.customfield_17018).toBeUndefined();
    expect(fields.customfield_10488).toEqual([{ accountId: PCM_MANAGER_APPROVER_ACCOUNT_ID }]);
    expect(fields.customfield_10485).toEqual(PCM_SLT_APPROVER_ACCOUNT_IDS.map((accountId) => ({ accountId })));
    expect(fields.assignee).toEqual({ accountId: "acct-me" });
    expect(fields.reporter).toEqual({ accountId: "acct-me" });
    expect(fields.duedate).toBe(toJiraDate("2026-10-02 10:00"));
    expect(fields.customfield_10133).toBe(toJiraDateTime("2026-10-02 10:00"));
    expect(fields.customfield_10134).toBe(toJiraDateTime("2026-10-02 11:00"));
    expect(fields.customfield_10081).toEqual([{ id: PCM_AFFECTED_SERVICE_ARI }]);
    expect(fields.labels).toEqual([...PCM_CHANGE_LABELS]);
  });

  it("maps patch Change reason to Maintenance", () => {
    expect(buildPcmChangeFields(release({ bump: "patch" })).customfield_10035).toEqual({ value: "Maintenance" });
  });
});

describe("toJiraDateTime", () => {
  it("keeps an already-formatted Jira datetime", () => {
    expect(toJiraDateTime("2026-10-02T10:00:00.000-0700")).toBe("2026-10-02T10:00:00.000-0700");
  });

  it("treats naive clock times as America/Chicago wall time", () => {
    expect(toJiraDateTime("2026-10-06 20:00", "America/Chicago")).toBe("2026-10-06T20:00:00.000-0500");
    expect(toJiraDateTime("2026-01-15 20:00", "America/Chicago")).toBe("2026-01-15T20:00:00.000-0600");
  });

  it("rejects empty input", () => {
    expect(() => toJiraDateTime("  ")).toThrow(/empty/);
  });
});

describe("affected services", () => {
  it("parses comma-separated names", () => {
    expect(parseAffectedServices("blog-microfrontend, payments")).toEqual(["blog-microfrontend", "payments"]);
  });

  it("uses ARIs as-is and looks up names", async () => {
    const ari = "ari:cloud:graph::service/cloud/svc";
    expect(await resolveAffectedServiceAris([ari])).toEqual([ari]);
    const ids = await resolveAffectedServiceAris(["Blog"], async () => [
      { id: ari, name: "Blog" },
      { id: "other", name: "Other" },
    ]);
    expect(ids).toEqual([ari]);
  });

  it("parses service registry payloads", () => {
    expect(parseServiceRegistryHits([{ id: "ari:1", name: "web" }])).toEqual([{ id: "ari:1", name: "web" }]);
    expect(parseServiceRegistryHits({ values: [{ id: "ari:2" }] })).toEqual([{ id: "ari:2" }]);
  });
});
