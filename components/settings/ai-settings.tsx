"use client";

import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CheckCircle2, ExternalLink, KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { AI_MODELS, deleteAiSettings, errMsg, OPENAI_COMPATIBLE_PRESETS, putAiSettings, qk, useAiSettings, type AiProvider } from "@/components/api";
import { Note, Section } from "@/components/seller/seller-settings";
import { useUser } from "@/components/shell/user-context";
import { Badge, Button, ErrorNote, inputCls, Spinner } from "@/components/ui";

const PROVIDERS: Array<{ id: AiProvider; label: string; hint: string }> = [
  { id: "openai-compatible", label: "OpenAI-compatible", hint: "OpenRouter (free models), OpenAI, Groq, Ollama…" },
  { id: "anthropic", label: "Anthropic", hint: "Claude models" },
];

/** Default for a new setup: OpenRouter (first preset), which offers free models. */
const DEFAULT_PROVIDER: AiProvider = "openai-compatible";
const OPENROUTER_FREE_MODELS_URL = "https://openrouter.ai/models?q=free";

function isOpenRouterUrl(url: string) {
  try {
    const h = new URL(url).hostname;
    return h === "openrouter.ai" || h.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function isLocalUrl(url: string) {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]";
  } catch {
    return false;
  }
}

/** "AI provider" section: per-user AI key + model (CONTRACTS-v2 §Per-user AI key). */
export function AiProviderSettings() {
  const user = useUser();
  const qc = useQueryClient();
  const { data, isPending: isLoading, error } = useAiSettings();
  const defaultModel = user.role === "buyer" ? "claude-sonnet-5-5" : "claude-haiku-5-5";

  const [provider, setProvider] = useState<AiProvider>(DEFAULT_PROVIDER);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(defaultModel);
  const [compatModel, setCompatModel] = useState("");
  const [baseUrl, setBaseUrl] = useState<string>(OPENAI_COMPATIBLE_PRESETS[0].baseUrl);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  // Load the saved config into the form.
  useEffect(() => {
    if (!data?.configured) return;
    setProvider(data.provider);
    if (data.provider === "anthropic") {
      if (data.model) setModel(data.model);
    } else {
      if (data.baseUrl) setBaseUrl(data.baseUrl);
      if (data.model) setCompatModel(data.model);
    }
  }, [data?.configured, data?.provider, data?.model, data?.baseUrl]);

  const configured = Boolean(data?.configured);
  const keyTrim = apiKey.trim();
  const baseTrim = baseUrl.trim();
  const compatTrim = compatModel.trim();
  const isCompat = provider === "openai-compatible";
  const preset = OPENAI_COMPATIBLE_PRESETS.find((p) => p.baseUrl === baseTrim.replace(/\/+$/, ""));
  const localEndpoint = isCompat && isLocalUrl(baseTrim);
  const openRouter = isCompat && isOpenRouterUrl(baseTrim);

  // Saving without a new key reuses the stored key — only when provider and endpoint are unchanged.
  const sameTarget = configured && data?.provider === provider && (!isCompat || data?.baseUrl === baseTrim.replace(/\/+$/, ""));
  const changed = isCompat ? !sameTarget || compatTrim !== (data?.model ?? "") : !sameTarget || model !== (data?.model ?? defaultModel);
  const canSave = isCompat
    ? Boolean(baseTrim && compatTrim) && (Boolean(keyTrim) || (sameTarget && changed) || (localEndpoint && (!sameTarget || changed)))
    : Boolean(keyTrim) || (sameTarget && changed);
  const testsKey = Boolean(keyTrim) || !sameTarget;

  function refresh() {
    qc.invalidateQueries({ queryKey: qk.aiSettings });
    qc.invalidateQueries({ queryKey: qk.status });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy("save");
    setMsg(null);
    try {
      await putAiSettings(
        isCompat
          ? { provider, model: compatTrim, baseUrl: baseTrim, ...(keyTrim ? { apiKey: keyTrim } : {}) }
          : { provider, model, ...(keyTrim ? { apiKey: keyTrim } : {}) },
      );
      setApiKey("");
      setMsg({ ok: true, t: testsKey ? "Connection tested and saved. Your agent is ready." : "Settings tested and saved." });
      refresh();
    } catch (err) {
      setMsg({ ok: false, t: errMsg(err) });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setMsg(null);
    try {
      await deleteAiSettings();
      setConfirmRemove(false);
      setApiKey("");
      setModel(defaultModel);
      setCompatModel("");
      setMsg({ ok: true, t: "Key removed. Your agent is paused until you add a new one." });
      refresh();
    } catch (err) {
      setMsg({ ok: false, t: errMsg(err) });
    } finally {
      setBusy(null);
    }
  }

  const activeLabel =
    data?.provider === "openai-compatible"
      ? `${data.model ?? "model"} via ${(() => {
          try {
            return new URL(data.baseUrl ?? "").host;
          } catch {
            return "custom endpoint";
          }
        })()}`
      : (AI_MODELS.find((m) => m.id === (data?.model ?? defaultModel))?.label ?? data?.model);

  return (
    <Section
      icon={<KeyRound className="size-4" />}
      title="AI provider"
      desc={
        user.role === "buyer"
          ? "Your buyer agent runs on your own AI API key (Anthropic or any OpenAI-compatible endpoint). It's encrypted at rest and never shown again."
          : "Your sales agent runs on your own AI API key (Anthropic or any OpenAI-compatible endpoint). It's encrypted at rest and never shown again."
      }
      right={
        isLoading ? (
          <Spinner />
        ) : data ? (
          <Badge tone={configured ? "ok" : "warn"}>
            {configured ? (
              <>
                Configured{data.last4 ? <span className="font-mono"> · ••••{data.last4}</span> : null}
              </>
            ) : (
              "Not configured"
            )}
          </Badge>
        ) : null
      }
    >
      {!!error && <ErrorNote className="mb-3">AI settings are unavailable right now ({errMsg(error)}).</ErrorNote>}

      {configured && (
        <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-2">
          <CheckCircle2 className="size-4 shrink-0 text-ok" />
          <span>
            {data?.provider === "openai-compatible" ? "OpenAI-compatible" : "Anthropic"}{" "}
            {data?.last4 ? (
              <>
                key <span className="font-mono text-xs">••••{data.last4}</span>
              </>
            ) : (
              "endpoint (no key)"
            )}{" "}
            is active
          </span>
          <span className="text-xs text-muted">· {activeLabel}</span>
        </p>
      )}

      <div role="radiogroup" aria-label="AI provider" className="mb-4 grid gap-2 sm:grid-cols-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={provider === p.id}
            onClick={() => {
              setProvider(p.id);
              setMsg(null);
            }}
            className={clsx(
              "rounded-lg border px-3 py-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              provider === p.id ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface-2",
            )}
          >
            <span className="block text-sm font-medium text-fg">{p.label}</span>
            <span className="block text-[11px] text-muted">{p.hint}</span>
          </button>
        ))}
      </div>

      <form onSubmit={save} className="grid gap-3 sm:grid-cols-[1fr_220px]">
        {isCompat && (
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-fg-2">
              Base URL
              <input
                type="url"
                name="ai-base-url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className={`${inputCls} mt-1 font-mono`}
              />
            </label>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted">Presets:</span>
              {OPENAI_COMPATIBLE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setBaseUrl(p.baseUrl)}
                  className={clsx(
                    "rounded-full border px-2 py-0.5 text-[11px] transition",
                    preset?.id === p.id ? "border-accent bg-accent-soft text-fg" : "border-line text-fg-2 hover:bg-surface-2",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span className="mt-1 block text-[11px] font-normal text-muted">
              Any server that speaks the OpenAI Chat Completions API. Your key is only sent to this URL. Local endpoints (localhost) work in development only.
            </span>
          </div>
        )}

        <label className="block text-xs font-medium text-fg-2">
          {configured && sameTarget ? "Replace API key" : isCompat ? (localEndpoint ? "API key (optional)" : "API key") : "Anthropic API key"}
          <input
            type="password"
            name="ai-api-key"
            autoComplete="off"
            spellCheck={false}
            placeholder={configured && sameTarget && data?.last4 ? `Current key ends in ${data.last4}` : isCompat ? (preset?.keyHint ?? "Your API key") : "sk-ant-…"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className={`${inputCls} mt-1 font-mono`}
          />
          <span className="mt-1 block text-[11px] font-normal text-muted">
            {isCompat ? (
              "Get it from your provider's dashboard. "
            ) : (
              <>
                Create one in the{" "}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
                  Anthropic Console <ExternalLink className="size-3" />
                </a>
                .{" "}
              </>
            )}
            We test it with a tiny request before saving.
          </span>
        </label>

        {isCompat ? (
          <label className="block text-xs font-medium text-fg-2">
            Model
            <input
              type="text"
              name="ai-model"
              autoComplete="off"
              spellCheck={false}
              placeholder={preset?.modelHint ?? "Model name"}
              value={compatModel}
              onChange={(e) => setCompatModel(e.target.value)}
              className={`${inputCls} mt-1 font-mono`}
            />
            <span className="mt-1 block text-[11px] font-normal text-muted">
              Exact model id as your provider names it{preset ? ` (${preset.modelHint})` : ""}.
              {openRouter && (
                <>
                  {" "}
                  Pick a model ending in <span className="font-mono">:free</span> from{" "}
                  <a href={OPENROUTER_FREE_MODELS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
                    OpenRouter&apos;s free models <ExternalLink className="size-3" />
                  </a>
                  . Free models are rate limited (per minute and per day), so agents may pause and retry.
                </>
              )}
            </span>
          </label>
        ) : (
          <label className="block text-xs font-medium text-fg-2">
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)} className={`${inputCls} mt-1`}>
              {AI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.id === defaultModel ? " (default)" : ""}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] font-normal text-muted">{AI_MODELS.find((m) => m.id === model)?.hint}</span>
          </label>
        )}

        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" loading={busy === "save"} disabled={!canSave || busy === "remove"}>
            {testsKey ? "Save & test" : "Save model"}
          </Button>
          {configured &&
            (confirmRemove ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Your agent stops working until you add a key.</span>
                <Button type="button" variant="danger" onClick={remove} loading={busy === "remove"}>
                  Remove key
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)} disabled={busy === "remove"}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button type="button" variant="ghost" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
                <Trash2 className="size-4" /> Remove
              </Button>
            ))}
        </div>
      </form>
      {msg && <Note ok={msg.ok}>{msg.t}</Note>}
    </Section>
  );
}
