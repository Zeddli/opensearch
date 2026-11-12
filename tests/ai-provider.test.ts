import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertPublicHost, checkBaseUrl, isLocalHost, isPrivateIp } from "@/src/agents/base-url";
import { extractJson, JsonTextError, parseJsonText } from "@/src/agents/json-text";

describe("checkBaseUrl", () => {
  const prod = { production: true };
  const dev = { production: false };

  it("accepts public https endpoints and strips trailing slashes", () => {
    expect(checkBaseUrl("https://api.openai.com/v1/", prod)).toEqual({ ok: true, url: "https://api.openai.com/v1", local: false });
    expect(checkBaseUrl(" https://openrouter.ai/api/v1 ", prod)).toMatchObject({ ok: true, url: "https://openrouter.ai/api/v1" });
    expect(checkBaseUrl("https://api.groq.com/openai/v1", prod)).toMatchObject({ ok: true });
  });

  it("rejects non-http schemes and malformed input", () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com/v1", "javascript:alert(1)", "data:text/plain,hi", "gopher://x.com", "not a url", ""]) {
      expect(checkBaseUrl(u, dev).ok, u).toBe(false);
      expect(checkBaseUrl(u, prod).ok, u).toBe(false);
    }
  });

  it("rejects embedded credentials and fragments", () => {
    expect(checkBaseUrl("https://user:pass@api.openai.com/v1", dev).ok).toBe(false);
    expect(checkBaseUrl("https://api.openai.com/v1#x", dev).ok).toBe(false);
  });

  it("allows localhost / private hosts in development only", () => {
    for (const u of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:11434/v1", "http://192.168.1.20:8080/v1", "http://ollama.localhost/v1"]) {
      expect(checkBaseUrl(u, dev), u).toMatchObject({ ok: true, local: true });
      expect(checkBaseUrl(u, prod).ok, u).toBe(false);
    }
  });

  it("blocks internal targets in production, including encoded IPs", () => {
    for (const u of [
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/v1",
      "https://172.16.3.4/v1",
      "https://100.64.0.1/v1",
      "https://0.0.0.0/v1",
      "https://2130706433/v1", // 127.0.0.1 as an integer
      "https://0x7f.0.0.1/v1",
      "https://[::ffff:127.0.0.1]/v1",
      "https://[fd00::1]/v1",
      "https://[fe80::1]/v1",
      "https://metadata.google.internal/v1",
      "https://redis/v1",
      "https://printer.local/v1",
    ]) {
      expect(checkBaseUrl(u, prod).ok, u).toBe(false);
    }
  });

  it("requires https in production", () => {
    expect(checkBaseUrl("http://api.openai.com/v1", prod).ok).toBe(false);
    expect(checkBaseUrl("http://api.openai.com/v1", dev).ok).toBe(true);
  });

  it("assertPublicHost is a no-op in development and rejects local names in production", async () => {
    await expect(assertPublicHost("http://localhost:11434/v1", { production: false })).resolves.toBeUndefined();
    await expect(assertPublicHost("https://localhost/v1", { production: true })).rejects.toThrow();
  });
});

describe("isPrivateIp / isLocalHost", () => {
  it("classifies addresses", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("[::ffff:7f00:1]")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("2606:4700::1111")).toBe(false);
    expect(isLocalHost("LOCALHOST")).toBe(true);
    expect(isLocalHost("api.openai.com")).toBe(false);
  });
});

describe("JSON-in-text fallback", () => {
  const Schema = z.object({ items: z.array(z.object({ name: z.string(), qty: z.number() })), note: z.string().optional() });

  it("parses plain JSON", () => {
    expect(parseJsonText('{"items":[{"name":"cups","qty":5000}]}', Schema)).toEqual({ items: [{ name: "cups", qty: 5000 }] });
  });

  it("parses fenced JSON surrounded by prose", () => {
    const text = 'Sure! Here you go:\n```json\n{"items":[{"name":"lids","qty":10}],"note":"ok"}\n```\nAnything else?';
    expect(parseJsonText(text, Schema)).toEqual({ items: [{ name: "lids", qty: 10 }], note: "ok" });
  });

  it("finds the first balanced object, ignoring braces inside strings and <think> blocks", () => {
    const text = '<think>maybe {"items": []}?</think>Result: {"items":[{"name":"a } b {","qty":1}]} trailing {junk';
    expect(parseJsonText(text, Schema)).toEqual({ items: [{ name: "a } b {", qty: 1 }] });
  });

  it("parses arrays", () => {
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("throws JsonTextError on no JSON or schema mismatch", () => {
    expect(() => parseJsonText("I cannot help with that.", Schema)).toThrow(JsonTextError);
    expect(() => parseJsonText('{"items":[{"name":"x","qty":"five"}]}', Schema)).toThrow(/items\.0\.qty/);
    try {
      parseJsonText("nope", Schema);
    } catch (e) {
      expect((e as Error).name).toBe("AI_NoObjectGeneratedError");
    }
  });
});
