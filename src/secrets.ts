/**
 * Where credentials live.
 *
 * The problem this solves is narrow and worth stating plainly, because the
 * obvious "encrypt data.json" answer does not solve it:
 *
 * A plugin's settings are a plain JSON file *inside the user's vault*. That
 * directory is routinely synced to a third party, committed to git, copied into
 * backups, and readable by anyone with the folder. The credential is exposed by
 * being in that artifact at all, not by being unencrypted.
 *
 * Encrypting it in place — via Electron `safeStorage` or a local key file —
 * would not change the threat model in any way that matters. Every other
 * installed plugin runs in the same process with the same permissions, so
 * whatever this plugin can decrypt, they can decrypt too. That is a property of
 * Obsidian's plugin model, not something a plugin can opt out of.
 *
 * So: move the secret out of the vault. Two routes, both plain text, both
 * outside anything that syncs:
 *
 *   1. An environment variable — never touches disk.
 *   2. A file in the OS config directory, created 0600.
 *
 * What this genuinely prevents: a vault sync carrying your credential to a
 * third party, `git add -A` publishing it, a backup snapshot preserving it
 * forever, another user reading your vault folder.
 *
 * What it does not prevent: a malicious Obsidian plugin, or malware already
 * running as you. Nothing available here does.
 *
 * Desktop only — the plugin is too, so there is no mobile path to consider.
 */

type NodeRequire = (id: string) => unknown;

function nodeRequire(): NodeRequire | null {
  const r = (window as unknown as { require?: NodeRequire }).require;
  return typeof r === "function" ? r : null;
}

export type SecretSource = "env" | "file" | "vault" | "unset";

export interface Resolved {
  value: string;
  source: SecretSource;
}

/** `claude-usage` → `TRMNL_UUID_CLAUDE_USAGE`. */
export function envVarName(screenId: string): string {
  return `TRMNL_UUID_${screenId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * The OS config directory, following each platform's own convention rather
 * than dropping a dotfile in $HOME. Returns null when Node is unavailable,
 * which on this plugin means something is very wrong.
 */
export function credentialsPath(): string | null {
  const req = nodeRequire();
  if (!req) return null;
  const path = req("path") as typeof import("path");
  const os = req("os") as typeof import("os");

  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");

  return path.join(base, "obsidian-trmnl", "credentials.json");
}

function readFileMap(): Record<string, string> {
  const req = nodeRequire();
  const file = credentialsPath();
  if (!req || !file) return {};
  const fs = req("fs") as typeof import("fs");
  try {
    if (!fs.existsSync(file)) return {};
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    // A malformed or unreadable credentials file must not take the plugin
    // down: fall through to the other sources and let the settings tab report
    // that nothing resolved. Throwing here would brick a working screen over a
    // stray comma.
    return {};
  }
}

/**
 * First hit wins: environment, then the external file, then whatever is still
 * stored in the vault's data.json.
 *
 * The vault case is deliberately last and deliberately still supported —
 * refusing to read it would break every existing install, and a working screen
 * the user can migrate beats a broken one they cannot.
 */
export function resolve(screenId: string, vaultValue: string): Resolved {
  const fromEnv = (process.env[envVarName(screenId)] ?? "").trim();
  if (fromEnv) return { value: fromEnv, source: "env" };

  const fromFile = (readFileMap()[screenId] ?? "").trim();
  if (fromFile) return { value: fromFile, source: "file" };

  const inVault = vaultValue.trim();
  if (inVault) return { value: inVault, source: "vault" };

  return { value: "", source: "unset" };
}

/**
 * Write one credential to the external file, creating the directory 0700 and
 * the file 0600.
 *
 * The modes are set explicitly on every write rather than only at creation:
 * `writeFileSync`'s mode argument is ignored for a file that already exists,
 * so a file created before this code — or by a different umask — would keep
 * whatever permissions it had. `chmodSync` afterwards is what actually
 * guarantees it. No-ops on Windows, which uses ACLs instead.
 */
export function writeExternal(screenId: string, value: string): string {
  const req = nodeRequire();
  const file = credentialsPath();
  if (!req || !file) throw new Error("no filesystem access — is this a desktop Obsidian?");
  const fs = req("fs") as typeof import("fs");
  const path = req("path") as typeof import("path");

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const map = readFileMap();
  if (value.trim()) map[screenId] = value.trim();
  else delete map[screenId];

  // Write-then-rename, not write-in-place. writeFileSync truncates first, so a
  // crash or a full disk midway through would leave a truncated file — and for
  // anyone who has used the Move button, this file is the only copy of the
  // credential. rename(2) within one directory is atomic: readers see either
  // the old file or the new one, never a half-written one.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);

  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Directory may be shared with something else that owns its mode.
    }
  }
  return file;
}

/** True when the external file already holds a value for this screen. */
export function hasExternal(screenId: string): boolean {
  return (readFileMap()[screenId] ?? "").trim().length > 0;
}

/** Human-readable description of where a value came from, for the settings UI. */
export function describe(source: SecretSource, screenId: string): string {
  switch (source) {
    case "env":
      return `Loaded from $${envVarName(screenId)} — never written to disk.`;
    case "file":
      return `Loaded from ${credentialsPath()} — outside the vault.`;
    case "vault":
      return "Stored in this vault's data.json — synced, backed up, and committed along with your notes.";
    case "unset":
      return "Not set.";
  }
}
