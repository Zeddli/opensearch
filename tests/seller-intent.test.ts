import { describe, expect, it } from "vitest";
import { isDealsQuestion, looksLikeProductListing } from "@/src/agents/seller/chat";

describe("seller chat intent guard", () => {
  it("treats product descriptions as listings (the dinosaur-toy case)", () => {
    expect(looksLikeProductListing("help me sell 100 dinasour toy, I ant each sell at 6 - 9 dollar each")).toBe(true);
    expect(looksLikeProductListing("I sell 12oz compostable cups, $0.30 each, 5000 in stock")).toBe(true);
    expect(looksLikeProductListing("add kraft bags 0.22 per unit, MOQ 200")).toBe(true);
  });

  it("does not hijack real deals questions", () => {
    expect(isDealsQuestion("how are my deals going?")).toBe(true);
    expect(looksLikeProductListing("how are my deals going?")).toBe(false);
    expect(looksLikeProductListing("any new offers?")).toBe(false);
  });

  it("ignores chit-chat", () => {
    expect(looksLikeProductListing("hello there")).toBe(false);
  });
});
