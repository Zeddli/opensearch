// Free-text replies from the LLM are shown to users as chat messages. Some models (esp. small/free
// OpenAI-compatible ones) echo the structured draft back as JSON or code fences — strip that out.
export function cleanReply(text: string): string {
  let t = text ?? "";
  // Drop fenced blocks (```json ... ```), including a trailing unclosed fence.
  t = t.replace(/`{2,}[\s\S]*?`{2,}/g, "");
  t = t.replace(/`{2,}[\s\S]*$/g, "");
  // Drop a trailing "Current draft:" / "Draft:" section and anything after it.
  t = t.replace(/\n\s*(\*\*)?(current\s+)?(draft|request|json)(\*\*)?\s*:?\s*\n[\s\S]*$/i, "");
  // Drop a trailing bare JSON object/array.
  t = t.replace(/\n\s*[{[][\s\S]*[}\]]\s*$/g, "");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}
