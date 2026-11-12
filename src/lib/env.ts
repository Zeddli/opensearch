// Typed server-side environment. Never throws at import time (safe during `next build`).
// Client components should read NEXT_PUBLIC_* vars directly via process.env.
// AI keys are NOT configured here: each user stores their own AI key (Anthropic or OpenAI-compatible) in Settings
// (table user_ai_settings, encrypted with APP_ENCRYPTION_KEY via src/lib/secrets.ts).

const str = (k: string, def = ""): string => (process.env[k] ?? "").trim() || def;
const int = (k: string, def: number): number => {
  const n = Number.parseInt(str(k), 10);
  return Number.isFinite(n) ? n : def;
};

export const DEV_ENCRYPTION_KEY = "dev-key-change-me";
const APP_ENCRYPTION_KEY = str("APP_ENCRYPTION_KEY", DEV_ENCRYPTION_KEY);

export const env = {
  NODE_ENV: str("NODE_ENV", "development"),
  DATABASE_URL: str("DATABASE_URL"),
  SESSION_SECRET: str("SESSION_SECRET", "dev-secret-change-me"),
  /** Key material for encrypting secrets at rest (users' AI keys, Shopify tokens). */
  APP_ENCRYPTION_KEY,
  PAYPAL_CLIENT_ID: str("PAYPAL_CLIENT_ID"),
  PAYPAL_CLIENT_SECRET: str("PAYPAL_CLIENT_SECRET"),
  PAYPAL_PARTNER_MERCHANT_ID: str("PAYPAL_PARTNER_MERCHANT_ID"),
  PAYPAL_BN_CODE: str("PAYPAL_BN_CODE"),
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: str("NEXT_PUBLIC_PAYPAL_CLIENT_ID"),
  PLATFORM_FEE_BPS: int("PLATFORM_FEE_BPS", 300),
  CHANNEL3_API_KEY: str("CHANNEL3_API_KEY"),
  NEXT_PUBLIC_AG_GRID_LICENSE_KEY: str("NEXT_PUBLIC_AG_GRID_LICENSE_KEY"),
  OFFER_WINDOW_SECONDS: int("OFFER_WINDOW_SECONDS", 45),
  APP_URL: str("APP_URL", "http://localhost:3000"),
} as const;

/** Platform integrations that are configured (credentials present). Missing => feature disabled. */
export const live = {
  paypal: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
  channel3: Boolean(env.CHANNEL3_API_KEY),
} as const;

export type ConfigStatus = "configured" | "missing";
/** Platform-level integration status (the per-user `ai` status is added by /api/status). */
export function integrationStatus(): { paypal: ConfigStatus; channel3: ConfigStatus } {
  return {
    paypal: live.paypal ? "configured" : "missing",
    channel3: live.channel3 ? "configured" : "missing",
  };
}
