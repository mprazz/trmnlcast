import type { App } from "obsidian";
import type { Screen } from "./types";

/**
 * Claude Code usage, read straight from the local transcripts.
 *
 * Deliberately NOT a shell-out to `ccusage`. That tool proved the approach
 * works and its block maths is the reference for what's below, but shelling
 * out adds a runtime dependency, an npx download on first run, and a process
 * spawn on every push — for an aggregation that is a hundred lines of loop.
 *
 * Desktop only: it reads outside the vault, so there is no Obsidian API for
 * it and `require("fs")` is unavailable on mobile. The collector says so
 * rather than returning zeros, because a usage screen that silently reads
 * "0 tokens" is worse than one that admits it can't see.
 */

/** Claude's usage windows are five hours, anchored to the top of the hour. */
const BLOCK_MS = 5 * 60 * 60 * 1000;

interface Entry {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const claudeUsage: Screen = {
  id: "claude-usage",
  label: "Claude usage",
  blurb: "Current 5-hour block, burn rate, reset time, and which model is doing the work.",
  // The only screen with a genuinely live number: the block moves all day.
  defaultEvery: 60,
  desktopOnly: true,

  async collect(_app: App) {
    const nodeRequire = (window as unknown as { require?: (m: string) => unknown }).require;
    if (!nodeRequire) {
      throw new Error("desktop only — this screen reads ~/.claude, which mobile Obsidian cannot");
    }
    const fs = nodeRequire("fs") as typeof import("fs");
    const path = nodeRequire("path") as typeof import("path");
    const os = nodeRequire("os") as typeof import("os");

    const root = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(root)) {
      throw new Error(`no transcripts at ${root}`);
    }

    const entries = readEntries(fs, path, root);
    if (entries.length === 0) throw new Error("no usage records found");
    entries.sort((a, b) => a.ts - b.ts);

    const now = Date.now();
    const block = activeBlock(entries, now);
    const today = dayTotals(entries, now);

    return {
      as_of: hhmm(now),
      // Same instant as `as_of`, but UTC epoch seconds so the template can
      // subtract it from Liquid's `"now"` and say how old the screen is.
      //
      // These numbers are only as fresh as the last push, and pushes stop dead
      // while the laptop is suspended — confirmed 18 Sep 2026, when a
      // 21:19→23:03 `deep` suspend swallowed two scheduled pushes and the panel
      // went on showing 21:19's block as if it were current. A bare wall clock
      // in the title bar does not communicate that on its own.
      //
      // Epoch, not the local HH:MM above, because the subtraction has to be
      // timezone-free. If TRMNL only re-renders when new data arrives then
      // `"now"` never advances past this and the badge simply never fires —
      // no worse than today. ~20 bytes either way.
      as_of_epoch: Math.floor(now / 1000),
      // --- current block ---
      active: block ? 1 : 0,
      resets_at: block ? hhmm(block.end) : "",
      // Rounded, not exact. This screen refreshes hourly, so a precise minute
      // count would be up to 59 minutes stale while looking authoritative.
      // "about 3h 30m" is honest at that refresh rate; "223 min" is not.
      // resets_at itself stays exact — it does not move within a block.
      left_approx: block ? approxLeft(block.end - now) : "",
      block_tokens: block ? compact(block.total) : "0",
      burn_per_min: block ? compact(block.perMinute) : "0",
      // Which model is actually doing the work right now, not all-time.
      top_model: block ? short(block.topModel) : "",
      // --- today, by model ---
      day_tokens: compact(today.total),
      models: today.models.slice(0, 3).map((m) => ({
        n: short(m.model),
        t: compact(m.total),
        // Integer percent so the template never has to round.
        p: today.total > 0 ? Math.round((m.total / today.total) * 100) : 0,
      })),
    };
  },
};

function readEntries(
  fs: typeof import("fs"),
  path: typeof import("path"),
  root: string,
): Entry[] {
  const out: Entry[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }

  for (const dir of dirs) {
    const full = path.join(root, dir);
    let files: string[];
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const f of files) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(full, f), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
        // Cheap pre-filter: skip the ~90% of lines with no usage block at all
        // rather than paying JSON.parse on every user message and tool result.
        if (!line.includes('"usage"')) continue;

        let d: Record<string, unknown>;
        try {
          d = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const msg = d.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, number> | undefined;
        const model = msg?.model;
        const ts = d.timestamp;
        if (!usage || typeof model !== "string" || typeof ts !== "string") continue;
        // Claude Code writes a "<synthetic>" model for locally generated
        // messages; they carry no tokens and would pollute the model split.
        if (model.startsWith("<")) continue;

        const t = Date.parse(ts);
        if (!Number.isFinite(t)) continue;

        out.push({
          ts: t,
          model,
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
        });
      }
    }
  }
  return out;
}

function tokens(e: Entry): number {
  return e.input + e.output + e.cacheWrite + e.cacheRead;
}

/**
 * The block containing `now`, if any. A block opens at the top of the hour of
 * its first message and runs five hours; a gap longer than that closes it.
 * This mirrors what Claude Code itself displays — but it is inferred from
 * local timestamps, not reported by the server, so a session on another
 * device is invisible here.
 */
function activeBlock(sorted: Entry[], now: number) {
  let start = 0;
  let members: Entry[] = [];

  for (const e of sorted) {
    if (members.length === 0 || e.ts - start >= BLOCK_MS || e.ts - members[members.length - 1].ts >= BLOCK_MS) {
      start = floorHour(e.ts);
      members = [e];
    } else {
      members.push(e);
    }
  }

  const end = start + BLOCK_MS;
  if (members.length === 0 || now >= end) return null;

  const total = members.reduce((n, e) => n + tokens(e), 0);
  const elapsedMin = Math.max(1, (now - start) / 60_000);

  const byModel = new Map<string, number>();
  for (const e of members) byModel.set(e.model, (byModel.get(e.model) ?? 0) + tokens(e));
  const topModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

  return { start, end, total, perMinute: Math.round(total / elapsedMin), topModel };
}

function dayTotals(sorted: Entry[], now: number) {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const byModel = new Map<string, number>();
  let total = 0;

  for (const e of sorted) {
    if (e.ts < midnight) continue;
    const t = tokens(e);
    total += t;
    byModel.set(e.model, (byModel.get(e.model) ?? 0) + t);
  }

  const models = [...byModel.entries()]
    .map(([model, mtotal]) => ({ model, total: mtotal }))
    .sort((a, b) => b.total - a.total);

  return { total, models };
}

function floorHour(ts: number): number {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/**
 * Coarse "time remaining", rounded to the half hour, floored at zero. Under an
 * hour it drops to the nearest 10 minutes — that is the range where the number
 * starts mattering again and the drift is proportionally smaller.
 */
function approxLeft(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 5) return "under 5m";
  if (mins < 60) return `about ${Math.round(mins / 10) * 10}m`;
  const halves = Math.round(mins / 30);
  const h = Math.floor(halves / 2);
  return halves % 2 === 0 ? `about ${h}h` : `about ${h}h 30m`;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** e-ink at a distance: "1.4M" reads, "1428573448" does not. */
function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
}

/** "claude-opus-5" → "Opus 5" */
function short(model: string): string {
  const m = model.match(/(opus|sonnet|haiku|fable)[-]?([\d.]+)?/i);
  if (!m) return model;
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return m[2] ? `${name} ${m[2]}` : name;
}
