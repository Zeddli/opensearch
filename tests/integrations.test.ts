import { afterEach, describe, expect, it, vi } from "vitest";

// env.ts reads process.env at import time, so each case re-imports with a fresh module graph.
const KEYS = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "CHANNEL3_API_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

async function withEnv(vars: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  vi.resetModules();
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

describe("PayPal not configured", () => {
  it("requirePayPal throws a 503 with the standard message", async () => {
    await withEnv({});
    const pp = await import("@/src/integrations/paypal/client");
    expect(pp.isPayPalConfigured()).toBe(false);
    let err: unknown;
    try {
      pp.requirePayPal();
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ status: 503, message: "PayPal is not configured on this server" });
  });
  it("is configured only when both client id and secret are set", async () => {
    await withEnv({ PAYPAL_CLIENT_ID: "id" });
    expect((await import("@/src/integrations/paypal/client")).isPayPalConfigured()).toBe(false);
    await withEnv({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" });
    const pp = await import("@/src/integrations/paypal/client");
    expect(pp.isPayPalConfigured()).toBe(true);
    expect(() => pp.requirePayPal()).not.toThrow();
  });
});

describe("Channel3 not configured", () => {
  it("searchMarket returns [] without calling the network", async () => {
    await withEnv({});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const c3 = await import("@/src/integrations/channel3");
    expect(c3.isChannel3Configured()).toBe(false);
    expect(await c3.searchMarket({ query: "500 compostable cups", quantity: 500 })).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(c3.CHANNEL3_UNAVAILABLE_NOTE).toBe("Public-web comparison unavailable (Channel3 not configured)");
    fetchSpy.mockRestore();
  });
});
