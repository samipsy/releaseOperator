import { describe, expect, it, vi } from "vitest";
import { NetlifyServiceError } from "../src/errors.js";
import { NetlifyRestProvider, netlifyDeployPermalink } from "../src/netlify/netlifyRestProvider.js";
import { lookupNetlifyDeploysForRepo, resolvePcmRollbackPlan } from "../src/netlify/rollbackPlan.js";
import type { NetlifyProvider } from "../src/netlify/types.js";
import type { Release } from "../src/types.js";

function releaseFor(repoName: string): Release {
  const now = new Date();
  return {
    id: "rel-1",
    version: "1.0.0",
    state: "TICKET_CREATE_PENDING",
    repos: [{ name: repoName, sourceBranch: "develop" }],
    environment: "prod",
    approvals: {},
    ci: { status: "unknown" },
    featureFlags: [],
    createdBy: "sam",
    createdAt: now,
    updatedAt: now,
  };
}

describe("NetlifyRestProvider.latestMainDeploy", () => {
  it("requests ready production deploys on main and returns the admin URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([
          {
            id: "dep-us",
            branch: "main",
            state: "ready",
            admin_url: "https://app.netlify.com/projects/quiz-ipsy/deploys/dep-us",
          },
        ]),
    });
    const provider = new NetlifyRestProvider({ token: "nfp_test", fetchImpl: fetchImpl as unknown as typeof fetch });

    const deploy = await provider.latestMainDeploy("quiz.ipsy.com");

    expect(deploy?.id).toBe("dep-us");
    expect(deploy?.adminUrl).toContain("dep-us");
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("/sites/quiz.ipsy.com/deploys");
    expect(url).toContain("branch=main");
    expect(url).toContain("production=true");
    const headers = fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(headers.headers.Authorization).toBe("Bearer nfp_test");
  });

  it("turns a project admin_url into a deploy permalink", async () => {
    expect(
      netlifyDeployPermalink("6abcb374a0bdad0009445252", "https://app.netlify.com/projects/landings-ipsy")
    ).toBe("https://app.netlify.com/projects/landings-ipsy/deploys/6abcb374a0bdad0009445252");
  });

  it("throws NetlifyServiceError on HTTP failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });
    const provider = new NetlifyRestProvider({ token: "bad", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.latestMainDeploy("quiz.ipsy.com")).rejects.toThrow(NetlifyServiceError);
  });
});

describe("resolvePcmRollbackPlan", () => {
  it("uses live US/MX deploy URLs when Netlify is configured", async () => {
    const netlify: NetlifyProvider = {
      latestMainDeploy: vi.fn(async (site: string) => {
        if (site.endsWith(".mx")) {
          return { id: "mx", adminUrl: "https://app.netlify.com/projects/quiz-ipsy-mx/deploys/mx" };
        }
        return { id: "us", adminUrl: "https://app.netlify.com/projects/quiz-ipsy/deploys/us" };
      }),
      latestDeployForBranch: vi.fn(),
    };

    const plan = await resolvePcmRollbackPlan(releaseFor("quiz-microfrontend"), netlify);

    expect(plan).toBe(
      [
        "Redeploy prev versions",
        "US: https://app.netlify.com/projects/quiz-ipsy/deploys/us",
        "MX: https://app.netlify.com/projects/quiz-ipsy-mx/deploys/mx",
      ].join("\n")
    );
    expect(netlify.latestMainDeploy).toHaveBeenCalledWith("quiz.ipsy.com");
    expect(netlify.latestMainDeploy).toHaveBeenCalledWith("quiz.ipsy.mx");
  });

  it("looks up landings US and MX deploys independently", async () => {
    const netlify: NetlifyProvider = {
      latestMainDeploy: vi.fn(async (site: string) => ({
        id: site.includes(".mx") ? "mx1" : "us1",
        adminUrl: `https://app.netlify.com/projects/${site}/deploys/x`,
        branch: "main",
      })),
      latestDeployForBranch: vi.fn(),
    };
    const result = await lookupNetlifyDeploysForRepo("landings", netlify);
    expect(result.sites.map((s) => s.site)).toEqual(["landings.ipsy.com", "landings.ipsy.mx"]);
    expect(result.sites.every((s) => s.ok)).toBe(true);
  });

  it("falls back to site homepages when lookup fails", async () => {
    const netlify: NetlifyProvider = {
      latestMainDeploy: vi.fn().mockRejectedValue(new Error("timeout")),
      latestDeployForBranch: vi.fn(),
    };
    const plan = await resolvePcmRollbackPlan(releaseFor("blog"), netlify);
    expect(plan).toContain("US: https://blog.ipsy.com");
    expect(plan).toContain("MX: https://blog.ipsy.mx");
  });
});
