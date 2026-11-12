// Route-handler helpers.
import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg = "Bad request", details?: unknown) => new HttpError(400, msg, details);
export const unauthorized = (msg = "Not signed in") => new HttpError(401, msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);

/** JSON response. */
export function json<T>(data: T, init?: number | ResponseInit): NextResponse {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

/**
 * Wrap a route handler: HttpError -> {error} with its status, ZodError -> 400 {error, issues},
 * anything else -> 500 (logged). Works with dynamic-route context args too:
 *   export const POST = handle(async (req, { params }) => { ... return json({...}) });
 */
export function handle<A extends unknown[]>(
  fn: (...args: A) => Promise<Response> | Response,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, details: err.details }, err.status);
      }
      if (err instanceof ZodError) {
        return json({ error: "Invalid input", issues: err.issues }, 400);
      }
      console.error("[api] unhandled error", err);
      return json({ error: "Internal server error" }, 500);
    }
  };
}

/** Parse a JSON body with a Zod schema (throws ZodError / 400 on bad JSON). */
export async function readJson<T>(req: Request, schema: { parse: (v: unknown) => T }): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw badRequest("Body must be valid JSON");
  }
  return schema.parse(body);
}
