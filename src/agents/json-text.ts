// Fallback for structured output on OpenAI-compatible servers that don't support json_schema
// response formats: the schema goes into the prompt and the JSON is pulled out of plain text.
import type { z } from "zod";

/** Thrown when the model's text can't be turned into an object matching the schema. */
export class JsonTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AI_NoObjectGeneratedError"; // same name as the AI SDK's error, so error mapping treats it alike
  }
}

/** Find the first balanced top-level JSON object/array in `text` (string-aware). */
function firstBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extract a JSON value from model text: the whole text, a ```json fenced block, or the first
 * balanced {...}/[...] (reasoning `<think>` blocks are skipped). Throws JsonTextError.
 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const candidates: string[] = [cleaned];
  for (const m of cleaned.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) candidates.push(m[1].trim());
  const bal = firstBalanced(cleaned);
  if (bal) candidates.push(bal);
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  throw new JsonTextError("The AI response did not contain valid JSON");
}

/** extractJson + zod validation. Throws JsonTextError with the first validation issue. */
export function parseJsonText<S extends z.ZodTypeAny>(text: string, schema: S): z.infer<S> {
  const value = extractJson(text);
  const r = schema.safeParse(value);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new JsonTextError(`The AI response did not match the expected shape${i ? ` (${i.path.join(".") || "root"}: ${i.message})` : ""}`);
  }
  return r.data;
}

/** System-prompt suffix telling the model to answer with JSON matching `jsonSchema`. */
export function jsonInstruction(jsonSchema: unknown): string {
  return (
    "\n\nRespond with ONLY a single JSON value that conforms to this JSON Schema. " +
    "No prose, no markdown fences, no comments.\nJSON Schema:\n" +
    JSON.stringify(jsonSchema)
  );
}
