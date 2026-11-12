// In-process background job runner (CONTRACTS §6). No persistence: jobs pending at
// process exit are lost. Handler errors are logged, never thrown to the caller.
type Handler = (payload: unknown) => Promise<void>;

const g = globalThis as unknown as { __aaJobs?: Map<string, Handler> };
const registry: Map<string, Handler> = (g.__aaJobs ??= new Map());

let handlersLoaded: Promise<unknown> | null = null;
/** Make sure src/jobs/handlers.ts has run its registerJob() calls. */
export function loadHandlers(): Promise<unknown> {
  return (handlersLoaded ??= import("./handlers").catch((err) => {
    handlersLoaded = null;
    console.error("[jobs] failed to load handlers", err);
  }));
}

export function registerJob<T>(name: string, handler: (payload: T) => Promise<void>): void {
  registry.set(name, handler as Handler);
}

export function enqueue<T>(name: string, payload: T, opts?: { delayMs?: number }): void {
  const delay = Math.max(0, opts?.delayMs ?? 0);
  setTimeout(() => void run(name, payload), delay);
}

async function run(name: string, payload: unknown): Promise<void> {
  try {
    await loadHandlers();
    const handler = registry.get(name);
    if (!handler) {
      console.warn(`[jobs] no handler registered for "${name}"`);
      return;
    }
    await handler(payload);
  } catch (err) {
    console.error(`[jobs] "${name}" failed`, err);
  }
}
