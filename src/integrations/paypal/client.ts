// Low-level PayPal REST client (sandbox by default). Server-only.
// - OAuth2 client-credentials token, cached in-process (survives HMR via globalThis)
// - `paypalFetch` adds Authorization, PayPal-Request-Id (idempotency) and
//   PayPal-Partner-Attribution-Id (BN code, when PAYPAL_BN_CODE is set)
// - Errors are thrown as PayPalError with status, name, issues and debug_id.
import { env } from "@/src/lib/env";
import { HttpError } from "@/src/lib/http";

/** Sandbox unless PAYPAL_ENV=live is set explicitly. */
export const PAYPAL_BASE_URL =
  (process.env.PAYPAL_ENV ?? "").trim().toLowerCase() === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

/** True when the platform operator configured PayPal (PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET). */
export const isPayPalConfigured = (): boolean => Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);

export const PAYPAL_NOT_CONFIGURED = "PayPal is not configured on this server";

/** Throws HttpError 503 {error: PAYPAL_NOT_CONFIGURED} when PayPal env is missing (use in routes). */
export function requirePayPal(): void {
  if (!isPayPalConfigured()) throw new HttpError(503, PAYPAL_NOT_CONFIGURED);
}

export type PayPalErrorDetail = { field?: string; value?: string; location?: string; issue?: string; description?: string };

export class PayPalError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public paypalName: string | undefined,
    public debugId: string | undefined,
    public details: PayPalErrorDetail[],
    public body: unknown,
  ) {
    const issues = details
      .map((d) => [d.issue, d.description, d.field].filter(Boolean).join(": "))
      .filter(Boolean)
      .join("; ");
    const msg = (body as { message?: string; error_description?: string } | null)?.message ??
      (body as { error_description?: string } | null)?.error_description ??
      "request failed";
    super(
      `PayPal ${method} ${path} failed (${status}${paypalName ? ` ${paypalName}` : ""}): ${msg}` +
        (issues ? ` [${issues}]` : "") +
        (debugId ? ` debug_id=${debugId}` : ""),
    );
    this.name = "PayPalError";
  }

  /** True if any detail issue (or the error name) matches. */
  hasIssue(...names: string[]): boolean {
    const set = new Set(names.map((n) => n.toUpperCase()));
    if (this.paypalName && set.has(this.paypalName.toUpperCase())) return true;
    return this.details.some((d) => d.issue && set.has(d.issue.toUpperCase()));
  }

  /** Text blob of the whole error (for fuzzy checks like "platform_fees"). */
  get text(): string {
    return `${this.message} ${JSON.stringify(this.body ?? "")}`.toLowerCase();
  }
}

type TokenState = { token: string | null; expiresAt: number; inflight: Promise<string> | null };
const g = globalThis as unknown as { __aaPayPalToken?: TokenState };
const tokenState: TokenState = (g.__aaPayPalToken ??= { token: null, expiresAt: 0, inflight: null });

async function fetchAccessToken(): Promise<string> {
  if (!isPayPalConfigured()) throw new HttpError(503, PAYPAL_NOT_CONFIGURED);
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    | null;
  if (!res.ok || !body?.access_token) {
    throw new PayPalError(res.status, "POST", "/v1/oauth2/token", body?.error, res.headers.get("paypal-debug-id") ?? undefined, [], body);
  }
  tokenState.token = body.access_token;
  // Refresh 60s before expiry.
  tokenState.expiresAt = Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000;
  return body.access_token;
}

/** Cached OAuth access token (client credentials). */
export async function getAccessToken(force = false): Promise<string> {
  if (!force && tokenState.token && Date.now() < tokenState.expiresAt) return tokenState.token;
  if (!tokenState.inflight) {
    tokenState.inflight = fetchAccessToken().finally(() => {
      tokenState.inflight = null;
    });
  }
  return tokenState.inflight;
}

export type PayPalFetchOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Idempotency key → PayPal-Request-Id header (POST). */
  requestId?: string;
  /** Prefer: return=representation (default true for POST). */
  representation?: boolean;
  /** Send PayPal-Partner-Attribution-Id when PAYPAL_BN_CODE is set (default true). */
  partnerAttribution?: boolean;
  headers?: Record<string, string>;
};

/** Typed PayPal REST call. `path` starts with "/" (e.g. "/v2/checkout/orders"). */
export async function paypalFetch<T = unknown>(path: string, opts: PayPalFetchOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const doFetch = async (token: string) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId.slice(0, 108);
    if ((opts.representation ?? method === "POST") && method !== "GET") headers["Prefer"] = "return=representation";
    if ((opts.partnerAttribution ?? true) && env.PAYPAL_BN_CODE) headers["PayPal-Partner-Attribution-Id"] = env.PAYPAL_BN_CODE;
    return fetch(`${PAYPAL_BASE_URL}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });
  };

  let res = await doFetch(await getAccessToken());
  if (res.status === 401) res = await doFetch(await getAccessToken(true)); // expired/revoked token

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 500) };
    }
  }
  if (!res.ok) {
    const b = (body ?? {}) as { name?: string; debug_id?: string; details?: PayPalErrorDetail[] };
    const err = new PayPalError(
      res.status,
      method,
      path,
      b.name,
      b.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined,
      Array.isArray(b.details) ? b.details : [],
      body,
    );
    console.error("[paypal]", err.message);
    throw err;
  }
  return body as T;
}

// ---- money helpers ----

/** 36000 -> "360.00" (integer math, no float drift). */
export function centsToValue(cents: number): string {
  const c = Math.round(cents);
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** "360.00" -> 36000 */
export function valueToCents(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === "") return 0;
  return Math.round(Number(value) * 100);
}
