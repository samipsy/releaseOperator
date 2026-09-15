import { describe, it, expect, vi } from "vitest";
import { LocalQwenProvider, DEFAULT_MODEL } from "../src/intelligence/localQwenProvider.js";
import { IntelligenceServiceError } from "../src/errors.js";
import type { Release } from "../src/types.js";

function makeRelease(overrides: Partial<Release> = {}): Release {
  const now = new Date();
  return {
    id: "rel-1",
    version: "1.0.0",
    state: "DRAFT",
    repos: [{ name: "web", sourceBranch: "main", releaseBranch: "release/1.0.0" }],
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

function chatCompletionResponse(content: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

describe("LocalQwenProvider", () => {
  it("sends the expected request shape to /v1/chat/completions", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatCompletionResponse("Drafted description."));
    const provider = new LocalQwenProvider({ fetchImpl, baseUrl: "http://127.0.0.1:8080" });

    const result = await provider.generateTicketDescription({ release: makeRelease() });

    expect(result).toBe("Drafted description.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body);
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("1.0.0");
  });

  it("strips a trailing slash from a configured baseUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatCompletionResponse("ok"));
    const provider = new LocalQwenProvider({ fetchImpl, baseUrl: "http://127.0.0.1:9000/" });

    await provider.generateTicketDescription({ release: makeRelease() });

    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:9000/v1/chat/completions");
  });

  it("throws IntelligenceServiceError with the response body on a non-OK HTTP status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "boom",
    } as Response);
    const provider = new LocalQwenProvider({ fetchImpl });

    await expect(provider.generateTicketDescription({ release: makeRelease() })).rejects.toThrow(
      IntelligenceServiceError
    );
    await expect(provider.generateTicketDescription({ release: makeRelease() })).rejects.toThrow(/500/);
  });

  it("throws a clear IntelligenceServiceError when the server is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED"));
    const provider = new LocalQwenProvider({ fetchImpl });

    await expect(provider.generateTicketDescription({ release: makeRelease() })).rejects.toThrow(
      /Could not reach the MLX-LM server/
    );
  });

  it("aborts and reports a timeout when the server never responds", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const provider = new LocalQwenProvider({ fetchImpl, timeoutMs: 20 });

    await expect(provider.generateTicketDescription({ release: makeRelease() })).rejects.toThrow(/timed out/);
  });

  it("parses a well-formed JSON array response for list-shaped tasks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatCompletionResponse('["web", "api"]'));
    const provider = new LocalQwenProvider({ fetchImpl });

    const result = await provider.identifyAffectedComponents({ release: makeRelease() });

    expect(result).toEqual(["web", "api"]);
  });

  it("parses a JSON array wrapped in a markdown code fence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatCompletionResponse('```json\n["web", "api"]\n```'));
    const provider = new LocalQwenProvider({ fetchImpl });

    const result = await provider.suggestSanityTests({ release: makeRelease() });

    expect(result).toEqual(["web", "api"]);
  });

  it("falls back to bullet-list parsing when the model doesn't return valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatCompletionResponse("- Check web login flow\n- Verify api health endpoint\n"));
    const provider = new LocalQwenProvider({ fetchImpl });

    const result = await provider.suggestSanityTests({ release: makeRelease() });

    expect(result).toEqual(["Check web login flow", "Verify api health endpoint"]);
  });

  it("reports reachable status with the loaded model list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: DEFAULT_MODEL }] }),
    } as Response);
    const provider = new LocalQwenProvider({ fetchImpl });

    const status = await provider.status();

    expect(status).toEqual({ reachable: true, models: [DEFAULT_MODEL] });
  });

  it("reports unreachable status on a connection failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const provider = new LocalQwenProvider({ fetchImpl });

    const status = await provider.status();

    expect(status.reachable).toBe(false);
  });

  it("summarizes commits and pull requests without needing a release", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatCompletionResponse("Summary text."));
    const provider = new LocalQwenProvider({ fetchImpl });

    const result = await provider.summarizeChanges({
      commits: [{ sha: "abc123def456", message: "fix: null pointer in checkout" }],
      pullRequests: [{ number: 42, title: "Fix checkout crash" }],
    });

    expect(result).toBe("Summary text.");
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[1].content).toContain("abc123de");
    expect(body.messages[1].content).toContain("#42");
  });
});
