// Runs once per server start. Registers background job handlers (Node runtime only).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { loadHandlers } = await import("@/src/jobs/runner");
    await loadHandlers();
  }
}
