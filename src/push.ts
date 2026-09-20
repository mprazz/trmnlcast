import { requestUrl } from "obsidian";

/**
 * Free accounts: 5 kB. TRMNL+ raises this to 10 kB.
 *
 * Taken from the Strategy field's own help text in the live plugin settings
 * form, not from docs.trmnl.com — that page still says 2 kB / 5 kB and is out
 * of date. The form is what the server actually enforces.
 */
export const FREE_PAYLOAD_BYTES = 5120;
/** Free accounts: 12/hour across every private plugin on the account. */
export const FREE_PUSHES_PER_HOUR = 12;

export interface PushResult {
  ok: boolean;
  /** True when we deliberately sent nothing (unchanged, or out of budget). */
  skipped?: "unchanged" | "budget";
  bytes: number;
  status?: number;
  error?: string;
}

export function encode(vars: Record<string, unknown>): { body: string; bytes: number } {
  const body = JSON.stringify({ merge_variables: vars });
  return { body, bytes: new TextEncoder().encode(body).length };
}

/**
 * Cheap, stable content hash. Not cryptographic — its only job is answering
 * "is this the same screen I already sent?", so collisions cost a missed
 * refresh, not correctness.
 */
export function digest(body: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36));
}

/**
 * Sliding-window budget shared by every screen, because the limit is
 * per *account*, not per plugin — and Home Assistant is spending from the
 * same pot if sensor-push is installed.
 */
export class Budget {
  constructor(private limit: number, private stamps: number[] = []) {}

  static from(limit: number, stamps: unknown): Budget {
    const list = Array.isArray(stamps) ? stamps.filter((n): n is number => typeof n === "number") : [];
    return new Budget(limit, list);
  }

  private prune(now: number) {
    const cutoff = now - 3_600_000;
    this.stamps = this.stamps.filter((t) => t > cutoff);
  }

  remaining(now = Date.now()): number {
    this.prune(now);
    return Math.max(0, this.limit - this.stamps.length);
  }

  /** Milliseconds until one slot frees up, or 0 if there's room now. */
  waitMs(now = Date.now()): number {
    this.prune(now);
    if (this.stamps.length < this.limit) return 0;
    return Math.max(0, this.stamps[0] + 3_600_000 - now);
  }

  spend(now = Date.now()) {
    this.stamps.push(now);
  }

  serialize(): number[] {
    this.prune(Date.now());
    return this.stamps;
  }
}

/** Best-effort extraction of a human-readable reason from a TRMNL error body. */
function detail(res: { text?: string; json?: unknown }): string {
  try {
    const j = res.json as Record<string, unknown> | undefined;
    for (const k of ["error", "message", "errors", "detail"]) {
      const v = j?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (Array.isArray(v) && v.length) return v.map(String).join("; ");
    }
  } catch {
    // Body was not JSON; fall through to the raw text.
  }
  const t = (res.text ?? "").trim();
  return t ? t.slice(0, 300) : "no detail returned";
}

export async function push(
  uuid: string,
  vars: Record<string, unknown>,
  opts: { budget: Budget; lastDigest?: string; maxBytes: number },
): Promise<PushResult & { digest: string }> {
  const { body, bytes } = encode(vars);
  const d = digest(body);

  // Nothing changed since the last successful send. Most timer ticks land
  // here, which is what keeps the hourly budget available for real updates.
  if (opts.lastDigest && opts.lastDigest === d) {
    return { ok: true, skipped: "unchanged", bytes, digest: d };
  }

  if (bytes > opts.maxBytes) {
    return {
      ok: false,
      bytes,
      digest: d,
      error: `payload is ${bytes} bytes, over the ${opts.maxBytes} limit — trim the collector`,
    };
  }

  if (opts.budget.remaining() <= 0) {
    return { ok: false, skipped: "budget", bytes, digest: d };
  }

  try {
    const res = await requestUrl({
      url: `https://trmnl.com/api/custom_plugins/${uuid}`,
      method: "POST",
      contentType: "application/json",
      body,
      // We want to inspect 429s ourselves rather than have them thrown.
      throw: false,
    });

    if (res.status === 429) {
      // The server disagrees with our local accounting. Trust the server:
      // burn the rest of the local window so we stop hammering it.
      while (opts.budget.remaining() > 0) opts.budget.spend();
      return { ok: false, bytes, status: 429, digest: d, error: "rate limited by TRMNL" };
    }
    if (res.status < 200 || res.status >= 300) {
      // TRMNL puts the actionable part in the body — e.g. a 442 means the
      // private plugin's Strategy field is still set to Polling rather than
      // Webhook. A bare status code sends you to their website to find that
      // out, so surface whatever they said.
      return { ok: false, bytes, status: res.status, digest: d, error: `HTTP ${res.status} — ${detail(res)}` };
    }

    opts.budget.spend();
    return { ok: true, bytes, status: res.status, digest: d };
  } catch (e) {
    return { ok: false, bytes, digest: d, error: e instanceof Error ? e.message : String(e) };
  }
}
