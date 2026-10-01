import { describe, expect, it } from "vitest";
import { displayReleaseVersion, formatReleaseNoteRow, formatReleaseNotesBlock } from "../src/releaseNotes.js";

describe("release note formatting", () => {
  it("prefixes a v when the computed version has none", () => {
    expect(displayReleaseVersion("0.42.0")).toBe("v0.42.0");
    expect(displayReleaseVersion("v1.2.3")).toBe("v1.2.3");
  });

  it("formats a table row with a nowrap Jira link", () => {
    expect(
      formatReleaseNoteRow({
        ticketKey: "APPS-12",
        ticketUrl: "https://ipsycorp.atlassian.net/browse/APPS-12",
        title: "Glow bag copy",
        author: "sam",
        prNumber: 88,
      })
    ).toBe(
      '| <a href="https://ipsycorp.atlassian.net/browse/APPS-12"><span style="white-space:nowrap">APPS&#8209;12</span></a> | Glow bag copy | @sam | #88 |'
    );
  });

  it("renders a markdown table for the PR and PCM ticket", () => {
    expect(
      formatReleaseNotesBlock([
        { ticketKey: "APPS-1", title: "One", prNumber: 1 },
        { ticketKey: "APPS-2", title: "Two", author: "sam", prNumber: 2 },
      ])
    ).toBe(
      [
        "| Ticket # | Title | Author | PR # |",
        "| --- | --- | --- | --- |",
        "| <span style=\"white-space:nowrap\">APPS&#8209;1</span> | One |  | #1 |",
        "| <span style=\"white-space:nowrap\">APPS&#8209;2</span> | Two | @sam | #2 |",
      ].join("\n")
    );
  });
});
