// Per-user AI provider config: Anthropic, or any OpenAI-compatible endpoint (base URL + model).
// The config is validated with a minimal real call before it is stored (key encrypted). The key is
// never returned — only the last 4 characters — and only ever sent to Anthropic or the user's
// validated base URL (see src/agents/base-url.ts for the SSRF rules).
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, userAiSettings } from "@/src/db";
import { requireUser } from "@/src/lib/auth";
import { badRequest, handle, HttpError, json, readJson } from "@/src/lib/http";
import { decryptSecret, encryptSecret } from "@/src/lib/secrets";
import { assertPublicHost, checkBaseUrl } from "@/src/agents/base-url";
import { AI_PROVIDERS, type AiConfig, DEFAULT_MODELS, getAiSettings, normalizeProvider, SUPPORTED_MODELS, validateAiConfig } from "@/src/agents/llm";

export const dynamic = "force-dynamic";

async function view(userId: string, role: "buyer" | "seller") {
  const s = await getAiSettings(userId);
  const provider = normalizeProvider(s?.provider);
  return {
    configured: Boolean(s),
    provider,
    baseUrl: s && provider === "openai-compatible" ? s.baseUrl : null,
    last4: s?.keyLast4 ?? null,
    model: s?.model ?? null,
    defaultModel: DEFAULT_MODELS[role],
    models: SUPPORTED_MODELS,
  };
}

export const GET = handle(async () => {
  const user = await requireUser();
  return json(await view(user.id, user.role));
});

const Body = z.object({
  provider: z.enum(AI_PROVIDERS).default("anthropic"),
  apiKey: z.string().trim().max(500).nullish(),
  model: z.string().trim().max(200).nullish(),
  baseUrl: z.string().trim().max(500).nullish(),
});

const CLAUDE_MODEL = /^claude-[a-z0-9.-]+$/;
const COMPAT_MODEL = /^[A-Za-z0-9._:/@+-]+$/;

export const PUT = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson(req, Body);
  const provider = body.provider;
  const existing = await getAiSettings(user.id);
  const inputKey = body.apiKey || null;
  if (provider === "anthropic" && inputKey != null && inputKey.length < 10) throw badRequest("API key looks too short");

  let model: string | null;
  let baseUrl: string | null = null;
  let local = false;
  if (provider === "anthropic") {
    model = body.model || null;
    if (model && !CLAUDE_MODEL.test(model)) throw badRequest("Model must be a Claude model id, e.g. claude-sonnet-5-5");
  } else {
    model = body.model || null;
    if (!model) throw badRequest("Model is required for an OpenAI-compatible endpoint");
    if (!COMPAT_MODEL.test(model)) throw badRequest("Model name contains unsupported characters");
    const check = checkBaseUrl(body.baseUrl ?? "");
    if (!check.ok) throw badRequest(check.error);
    try {
      await assertPublicHost(check.url);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Base URL is not allowed");
    }
    baseUrl = check.url;
    local = check.local;
  }

  // Key: the new one, else the stored one when provider (and endpoint) are unchanged, else none
  // (allowed only for a local OpenAI-compatible endpoint in development, e.g. Ollama).
  let apiKey = inputKey;
  if (apiKey == null && existing && normalizeProvider(existing.provider) === provider && (existing.baseUrl ?? null) === baseUrl) {
    try {
      apiKey = decryptSecret(existing.apiKeyEnc);
    } catch {
      apiKey = null;
    }
  }
  if (!apiKey) {
    if (provider === "openai-compatible" && local && process.env.NODE_ENV !== "production") apiKey = "";
    else throw badRequest("API key is required");
  }

  const cfg: AiConfig = { provider, apiKey, model: model || DEFAULT_MODELS[user.role], baseUrl };
  const check = await validateAiConfig(cfg);
  // A 429 means the provider accepted the key but the (often free-tier) model is busy: save it anyway.
  if (!check.ok && check.kind !== "rate_limited") {
    if (check.kind === "upstream") throw new HttpError(502, `Couldn't verify the key: ${check.message}`);
    throw badRequest(check.message);
  }

  const db = await getDb();
  const values = {
    provider,
    apiKeyEnc: encryptSecret(apiKey),
    keyLast4: apiKey ? apiKey.slice(-4) : null,
    model,
    baseUrl,
    updatedAt: new Date(),
  };
  await db
    .insert(userAiSettings)
    .values({ userId: user.id, ...values })
    .onConflictDoUpdate({ target: userAiSettings.userId, set: values });
  return json(await view(user.id, user.role));
});

export const DELETE = handle(async () => {
  const user = await requireUser();
  const db = await getDb();
  await db.delete(userAiSettings).where(eq(userAiSettings.userId, user.id));
  return json(await view(user.id, user.role));
});
