import { APICallError, generateText, type LanguageModel } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type AiConfig,
  isOpenRouterHost,
  isStructuredOutputFailure,
  LlmError,
  MAX_RATE_LIMIT_WAIT_MS,
  objectCall,
  openAiCompatibleModel,
  RATE_LIMIT_TEXT,
  retryAfterMs,
  withRetry,
  withUserSlot,
} from "@/src/agents/llm";

const apiError = (statusCode: number, o: { headers?: Record<string, string>; message?: string; body?: string } = {}) =>
  new APICallError({
    message: o.message ?? `HTTP ${statusCode}`,
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: o.headers,
    responseBody: o.body,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: "stop" as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  warnings: [],
});

const Schema = z.object({ answer: z.string(), n: z.number() });
const base = { userId: "u1", who: "buyer" as const, label: "test", system: "sys", prompt: "hi", schema: Schema };
let seq = 0;
/** A fresh endpoint per test so the "text JSON only" cache never leaks between cases. */
const cfg = (): AiConfig => ({ provider: "openai-compatible", apiKey: "k", model: "m:free", baseUrl: `https://openrouter.ai/api/v1/t${++seq}` });

/** Mock model: `structured(n)` answers calls that carry a JSON response format, `text(n)` the others. */
function mockModel(h: { structured: (n: number) => Promise<ReturnType<typeof textResult>>; text?: (n: number) => Promise<ReturnType<typeof textResult>> }) {
  const calls = { structured: 0, text: 0 };
  const model = new MockLanguageModelV2({
    doGenerate: async (opts) => {
      if (opts.responseFormat?.type === "json") return h.structured(++calls.structured);
      return (h.text ?? (async () => textResult('{"answer":"text","n":2}')))(++calls.text);
    },
  });
  return { model: model as unknown as LanguageModel, calls };
}

describe("structured output fallback (JSON in text)", () => {
  it("falls back when the endpoint rejects response_format, and skips straight to text afterwards", async () => {
    const { model, calls } = mockModel({ structured: async () => Promise.reject(apiError(400, { message: "response_format is not supported" })) });
    const c = cfg();
    expect(await objectCall(base, model, c, { textModel: async () => model })).toEqual({ answer: "text", n: 2 });
    expect(await objectCall(base, model, c, { textModel: async () => model })).toEqual({ answer: "text", n: 2 });
    expect(calls).toEqual({ structured: 1, text: 2 });
  });

  it("treats OpenRouter's 404 'no endpoints support the requested parameters' as a rejection", async () => {
    const err = apiError(404, { message: "No endpoints found that can handle the requested parameters." });
    expect(isStructuredOutputFailure(err)).toBe("rejected");
    expect(isStructuredOutputFailure(apiError(404, { message: "Model not found" }))).toBeNull();
    const { model, calls } = mockModel({ structured: async () => Promise.reject(err) });
    expect(await objectCall(base, model, cfg(), { textModel: async () => model })).toEqual({ answer: "text", n: 2 });
    expect(calls).toEqual({ structured: 1, text: 1 });
  });

  it("falls back when the model ignores response_format and answers in prose", async () => {
    const { model, calls } = mockModel({ structured: async () => textResult("Sure! The answer is yes.") });
    expect(await objectCall(base, model, cfg(), { textModel: async () => model })).toEqual({ answer: "text", n: 2 });
    expect(calls).toEqual({ structured: 1, text: 1 });
  });

  it("uses fenced JSON from an ignored response_format without a second request", async () => {
    const { model, calls } = mockModel({ structured: async () => textResult('Here you go:\n```json\n{"answer":"fenced","n":1}\n```') });
    expect(await objectCall(base, model, cfg(), { textModel: async () => model })).toEqual({ answer: "fenced", n: 1 });
    expect(calls).toEqual({ structured: 1, text: 0 });
  });

  it("retries once when the text answer is not valid JSON, then fails with a readable error", async () => {
    const { model, calls } = mockModel({
      structured: async () => Promise.reject(apiError(400)),
      text: async () => textResult("no json here"),
    });
    await expect(objectCall(base, model, cfg(), { textModel: async () => model })).rejects.toThrow(/couldn't parse/);
    expect(calls.text).toBe(2);
  });
});

describe("rate limits (HTTP 429)", () => {
  it("parses Retry-After / retry-after-ms / x-ratelimit-reset", () => {
    const now = 1_800_000_000_000;
    expect(retryAfterMs(apiError(429, { headers: { "retry-after": "3" } }), now)).toBe(3000);
    expect(retryAfterMs(apiError(429, { headers: { "Retry-After-Ms": "1500" } }), now)).toBe(1500);
    expect(retryAfterMs(apiError(429, { headers: { "retry-after": new Date(now + 5000).toUTCString() } }), now)).toBe(5000);
    expect(retryAfterMs(apiError(429, { headers: { "x-ratelimit-reset": String(now + 7000) } }), now)).toBe(7000); // epoch ms (OpenRouter)
    expect(retryAfterMs(apiError(429, { headers: { "x-ratelimit-reset": String(now / 1000 + 9) } }), now)).toBe(9000); // epoch s
    expect(retryAfterMs(apiError(429), now)).toBeNull();
  });

  it("honours Retry-After and succeeds on a later attempt", async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await withRetry(
      "t",
      async () => {
        if (++n < 3) throw apiError(429, { headers: { "retry-after": "2" } });
        return "ok";
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(out).toBe("ok");
    expect(n).toBe(3);
    expect(waits).toEqual([2000, 2000]);
  });

  it("backs off without a header and gives up after two retries with a clear message", async () => {
    const waits: number[] = [];
    let n = 0;
    const p = withRetry(
      "t",
      async () => {
        n++;
        throw apiError(429);
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    await expect(p).rejects.toBeInstanceOf(LlmError);
    await expect(p).rejects.toThrow(RATE_LIMIT_TEXT);
    expect(n).toBe(3);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(4000);
    expect(waits[1]).toBeGreaterThanOrEqual(10_000);
  });

  it("fails right away when the provider asks for a long wait (e.g. a daily quota)", async () => {
    let n = 0;
    const waits: number[] = [];
    const p = withRetry(
      "t",
      async () => {
        n++;
        throw apiError(429, { headers: { "retry-after": String(MAX_RATE_LIMIT_WAIT_MS / 1000 + 3600) } });
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    await expect(p).rejects.toMatchObject({ message: RATE_LIMIT_TEXT, status: 429 });
    expect(n).toBe(1);
    expect(waits).toEqual([]);
  });

  it("does not retry permanent errors (401)", async () => {
    let n = 0;
    await expect(
      withRetry("t", async () => {
        n++;
        throw apiError(401);
      }),
    ).rejects.toThrow(/401/);
    expect(n).toBe(1);
  });
});

describe("per-user LLM queue", () => {
  it("runs one call at a time per user (FIFO) and keeps users independent", async () => {
    const active: Record<string, number> = {};
    const peak: Record<string, number> = {};
    const order: string[] = [];
    const job = (user: string, id: string) =>
      withUserSlot(user, 1, async () => {
        active[user] = (active[user] ?? 0) + 1;
        peak[user] = Math.max(peak[user] ?? 0, active[user]);
        await new Promise((r) => setTimeout(r, 5));
        order.push(id);
        active[user]--;
        return id;
      });
    const results = await Promise.all([job("a", "a1"), job("a", "a2"), job("a", "a3"), job("b", "b1"), job("b", "b2")]);
    expect(results).toEqual(["a1", "a2", "a3", "b1", "b2"]);
    expect(peak).toEqual({ a: 1, b: 1 });
    expect(order.filter((x) => x.startsWith("a"))).toEqual(["a1", "a2", "a3"]);
  });

  it("allows a higher limit and releases the slot when a call throws", async () => {
    let active = 0;
    let peak = 0;
    const job = (fail: boolean) =>
      withUserSlot("c", 2, async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (fail) throw new Error("boom");
        return "ok";
      });
    const res = await Promise.allSettled([job(true), job(false), job(false), job(false)]);
    expect(res.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled", "fulfilled"]);
    expect(peak).toBe(2);
  });
});

describe("OpenRouter attribution", () => {
  const chatOk = () =>
    new Response(JSON.stringify({ id: "x", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("sends HTTP-Referer / X-Title to openrouter.ai only", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return chatOk();
    });
    try {
      await generateText({ model: openAiCompatibleModel("https://openrouter.ai/api/v1", "k", "m:free"), prompt: "hi", maxRetries: 0 });
      await generateText({ model: openAiCompatibleModel("https://api.groq.com/openai/v1", "k", "m"), prompt: "hi", maxRetries: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(seen[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen[0].headers.get("x-title")).toBe("OpenQuote");
    expect(seen[0].headers.get("http-referer")).toMatch(/^https?:\/\//);
    expect(seen[1].headers.get("x-title")).toBeNull();
    expect(seen[1].headers.get("http-referer")).toBeNull();
  });

  it("recognises openrouter.ai hosts only", () => {
    expect(isOpenRouterHost("openrouter.ai")).toBe(true);
    expect(isOpenRouterHost("api.openrouter.ai")).toBe(true);
    expect(isOpenRouterHost("openrouter.ai.evil.com")).toBe(false);
    expect(isOpenRouterHost("api.openai.com")).toBe(false);
  });
});
