import { IntelligenceServiceError } from "../errors.js";
import {
  affectedComponentsPrompt,
  changeSummaryPrompt,
  extractTicketKeysPrompt,
  failureSummaryPrompt,
  releaseNotesPrompt,
  sanityTestSuggestionPrompt,
  ticketDescriptionPrompt,
  type ChatMessage,
} from "./prompts.js";
import type {
  AffectedComponentsInput,
  ChangeSummaryInput,
  ExtractTicketKeysInput,
  FailureSummaryInput,
  IntelligenceProvider,
  ReleaseNotesInput,
  SanityTestSuggestionInput,
  TicketDescriptionInput,
} from "./types.js";
import { ticketKeysFromText, uniqueTicketKeys } from "./ticketKeys.js";

/**
 * Verified via Hugging Face on 2026-09-14: mlx-community/Qwen3-4B-Instruct-2507-4bit is a
 * text-only (non-vision) instruct model converted from Qwen/Qwen3-4B-Instruct-2507 with
 * mlx-lm 0.26.2, Apache-2.0, ~2.26GB on disk — comfortably within 24GB unified RAM, and
 * explicitly documented as servable via `mlx_lm.server --model <this repo>`.
 */
export const DEFAULT_MODEL = "mlx-community/Qwen3-4B-Instruct-2507-4bit";

/** mlx_lm.server bind address used by `npm run mlx:serve` (port 8081 so 8080 stays free for Jira OAuth). */
export const DEFAULT_BASE_URL = "http://127.0.0.1:8081";

export interface LocalQwenProviderOptions {
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

interface ModelsResponse {
  data?: { id: string }[];
}

/**
 * Talks to a local MLX-LM server (`mlx_lm.server`) over its OpenAI-compatible HTTP API.
 * This class has no knowledge of ReleaseState, guards, or transitions — it only ever
 * turns structured input into a chat completion request and returns the model's text.
 */
export class LocalQwenProvider implements IntelligenceProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LocalQwenProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.temperature = options.temperature ?? 0.3;
    this.maxTokens = options.maxTokens ?? 600;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GET /v1/models — a lightweight reachability/health check, not used by any generation call. */
  async status(): Promise<{ reachable: true; models: string[] } | { reachable: false; reason: string }> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/models`);
      if (!res.ok) {
        return { reachable: false, reason: `HTTP ${res.status} ${res.statusText}` };
      }
      const body = (await res.json()) as ModelsResponse;
      return { reachable: true, models: (body.data ?? []).map((m) => m.id) };
    } catch (err) {
      return { reachable: false, reason: describeFetchError(err) };
    }
  }

  private async chat(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          stream: false,
        }),
      });
    } catch (err) {
      throw new IntelligenceServiceError(
        `Could not reach the MLX-LM server at ${this.baseUrl}. Is it running? ` +
          `Start it with: mlx_lm.server --model ${this.model} (${describeFetchError(err)})`,
        err
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new IntelligenceServiceError(
        `MLX-LM server at ${this.baseUrl} returned HTTP ${res.status} ${res.statusText}: ${text}`
      );
    }

    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new IntelligenceServiceError(
        `MLX-LM server at ${this.baseUrl} returned a response with no completion content`
      );
    }
    return content.trim();
  }

  async generateTicketDescription(input: TicketDescriptionInput): Promise<string> {
    return this.chat(ticketDescriptionPrompt(input));
  }

  async extractTicketKeys(input: ExtractTicketKeysInput): Promise<string[]> {
    const fromMessages = uniqueTicketKeys(input.commits.flatMap((c) => ticketKeysFromText(c.message)));
    if (input.commits.length === 0) return [];
    try {
      const fromModel = uniqueTicketKeys(parseStringArray(await this.chat(extractTicketKeysPrompt(input))));
      return uniqueTicketKeys([...fromModel, ...fromMessages]);
    } catch {
      return fromMessages;
    }
  }

  async summarizeChanges(input: ChangeSummaryInput): Promise<string> {
    return this.chat(changeSummaryPrompt(input));
  }

  async generateReleaseNotes(input: ReleaseNotesInput): Promise<string> {
    return this.chat(releaseNotesPrompt(input));
  }

  async identifyAffectedComponents(input: AffectedComponentsInput): Promise<string[]> {
    return parseStringArray(await this.chat(affectedComponentsPrompt(input)));
  }

  async suggestSanityTests(input: SanityTestSuggestionInput): Promise<string[]> {
    return parseStringArray(await this.chat(sanityTestSuggestionPrompt(input)));
  }

  async summarizeFailure(input: FailureSummaryInput): Promise<string> {
    return this.chat(failureSummaryPrompt(input));
  }
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "AbortError" ? "request timed out" : err.message;
  }
  return String(err);
}

/**
 * A 4B local model won't always perfectly follow "respond with only a JSON array"
 * instructions. Try strict JSON first, then fall back to parsing a plain bullet/numbered
 * list so the caller still gets a usable string[] instead of a thrown error.
 */
function parseStringArray(text: string): string[] {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fencedMatch ? fencedMatch[1] : text).trim();

  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed.map((item) => item.trim()).filter((item) => item.length > 0);
    }
  } catch {
    // fall through to line-based parsing
  }

  return candidate
    .split("\n")
    .map((line) => line.trim().replace(/^[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length > 0);
}
