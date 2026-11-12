import { describe, expect, it } from "vitest";
import { cleanReply } from "@/src/agents/clean-reply";

describe("cleanReply", () => {
  it("strips a trailing 'Current draft' JSON block (screenshot case, malformed fence)", () => {
    const raw =
      "Thanks! I've recorded **100 dinosaur toys**. I still need:\n\n1. **Total budget**\n2. **Deadline**\n\n" +
      "Once I have those, I'll publish the request.\n\nCurrent draft:\n`` json\n{\n  \"item\": \"dinosaur toy\",\n  \"quantity\": 100\n}";
    const out = cleanReply(raw);
    expect(out).toContain("I'll publish the request.");
    expect(out).not.toMatch(/draft|json|\{/i);
  });

  it("strips fenced code blocks in the middle", () => {
    expect(cleanReply('Here:\n```json\n{"a":1}\n```\nWhat is your budget?')).toBe("Here:\n\nWhat is your budget?");
  });

  it("leaves normal text untouched", () => {
    const t = "Got it — 500 cups to Austin by Nov 19. What's your total budget?";
    expect(cleanReply(t)).toBe(t);
  });
});
