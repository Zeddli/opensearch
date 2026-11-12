// Validation of user-supplied OpenAI-compatible base URLs (Settings → AI provider).
//
// The server makes requests to this URL with the user's key, so it must not become an SSRF
// primitive: only http(s), no embedded credentials, and in production no loopback / private /
// link-local / internal targets (checked on the literal host here and on DNS results in
// `assertPublicHost`). In development, localhost etc. are allowed so a local Ollama / LM Studio works.

export type BaseUrlCheck = { ok: true; url: string; local: boolean } | { ok: false; error: string };

const isProd = () => process.env.NODE_ENV === "production";

/** Parse an IPv4 dotted quad into 4 octets, or null. */
function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

function isPrivateIpv4(o: number[]): boolean {
  const [a, b] = o;
  return (
    a === 0 || // "this" network / 0.0.0.0
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && o[2] === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved + broadcast
  );
}

/** Expand an IPv6 literal (no brackets) into 8 16-bit groups, or null. Handles embedded IPv4. */
function ipv6Groups(host: string): number[] | null {
  let h = host.toLowerCase();
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(h) || !h.includes(":")) return null;
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    h = h.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const parts = h.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (parts.length === 1 ? head.length !== 8 : fill < 1) return null;
  const all = [...head, ...Array(parts.length === 2 ? fill : 0).fill("0"), ...tail];
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

function isPrivateIpv6(g: number[]): boolean {
  const allZeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUntil(8)) return true; // ::
  if (allZeroUntil(7) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge by the IPv4 part.
  if (allZeroUntil(5) && (g[5] === 0xffff || g[5] === 0)) {
    return isPrivateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True for loopback / private / link-local / reserved IP literals (v4 or v6, with or without brackets). */
export function isPrivateIp(ip: string): boolean {
  const host = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const v4 = ipv4Octets(host);
  if (v4) return isPrivateIpv4(v4);
  const v6 = ipv6Groups(host);
  return v6 ? isPrivateIpv6(v6) : false;
}

/** Hostnames that point at the local machine or an internal network by name. */
function isInternalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (!h.includes(".") && !h.startsWith("[")) return true; // single-label names (e.g. "redis", "metadata")
  return /\.(local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(h) || h === "metadata.google.internal";
}

/** Loopback / private host (by literal IP or name). */
export function isLocalHost(host: string): boolean {
  return isPrivateIp(host) || isInternalHostname(host);
}

/**
 * Validate and normalise a base URL. `production` defaults to NODE_ENV === 'production'.
 * Production: https only, public hosts only. Development: http(s), local hosts allowed.
 */
export function checkBaseUrl(raw: string, opts: { production?: boolean } = {}): BaseUrlCheck {
  const production = opts.production ?? isProd();
  const input = raw.trim();
  if (!input) return { ok: false, error: "Base URL is required" };
  if (input.length > 500) return { ok: false, error: "Base URL is too long" };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: "Base URL must be a valid http(s) URL, e.g. https://api.openai.com/v1" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "Base URL must start with http:// or https://" };
  if (u.username || u.password) return { ok: false, error: "Base URL must not contain credentials" };
  if (u.hash) return { ok: false, error: "Base URL must not contain a #fragment" };
  if (!u.hostname) return { ok: false, error: "Base URL needs a host" };
  const local = isLocalHost(u.hostname);
  if (production) {
    if (local) return { ok: false, error: "Base URL must be a public endpoint (local and private network addresses are not allowed)" };
    if (u.protocol !== "https:") return { ok: false, error: "Base URL must use https://" };
  }
  const url = u.toString().replace(/\/+$/, "");
  return { ok: true, url, local };
}

/**
 * Production only: resolve the host and reject it if any address is private (blocks public names
 * that point at internal IPs). Throws an Error with a user-readable message.
 */
export async function assertPublicHost(url: string, opts: { production?: boolean } = {}): Promise<void> {
  if (!(opts.production ?? isProd())) return;
  const host = new URL(url).hostname;
  if (isLocalHost(host)) throw new Error("Base URL must be a public endpoint");
  if (isPrivateIp(host) || ipv4Octets(host) || host.startsWith("[")) return; // public IP literal
  const { lookup } = await import("node:dns/promises");
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Could not reach the endpoint");
  }
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("Base URL must be a public endpoint (it resolves to a private address)");
}
