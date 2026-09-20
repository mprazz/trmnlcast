# Claude Usage for TRMNL

A small framework for pushing anything you can compute in Obsidian to a
[TRMNL](https://trmnl.com) e-ink display — shipping with one screen built in:
your Claude Code token usage.

The screen is the demo. The point is the machinery around it.

```ts
export const myScreen: Screen = {
  id: "my-screen",
  label: "My screen",
  blurb: "One line describing what lands on the display.",
  defaultEvery: 360,
  async collect(app) {
    return { headline: "42", as_of: "14:05" };
  },
};
```

Add that to an array, write four Liquid templates, done. You get the scheduler,
the push budget, a settings UI and the error handling for free.

## What the framework gives you

| | |
|---|---|
| **Per-screen scheduling** | One ticker; each screen declares how often its data actually changes. A screen that isn't due costs nothing. |
| **Shared push budget** | TRMNL allows 12 pushes/hour per *account* (30 on TRMNL+). A sliding window tracks it across every screen, with what's left shown in the status bar. |
| **Unchanged-payload skip** | A content hash means re-sending identical data costs no budget — most ticks land here. |
| **Real Obsidian settings UI** | Per-screen enable, webhook UUID, refresh override, a Push button, and a live payload byte counter against your tier's limit. |
| **Credential masking** | Every field holding a UUID or token is a masked input. |
| **Guards for the mistakes that don't look like mistakes** | Duplicate-UUID detection, over-budget schedule warning, mobile skip for desktop-only screens. |
| **Loud failures** | A collector that can't read its source throws. It never quietly reports zero. |

Adding a screen means writing a `collect()` and four templates. Nothing else —
no settings field, no timer, no push call.

[**AGENTS.md**](AGENTS.md) is the full guide to writing one. It's aimed at
coding agents, but it's the honest documentation either way: the screen
contract, the budget model, and the TRMNL layout traps that cost real time to
find — including three places where `docs.trmnl.com` disagrees with the
platform.

## The built-in screen: Claude Code usage

Reads your local Claude Code transcripts, works out where you are in the current
five-hour usage block, and pushes a summary. No API key, no third-party service,
no `npx` — the numbers come from files already on your disk.

- When the current usage block resets, and roughly how long is left
- Tokens used this block, and the current burn rate per minute
- Today's total, split by model
- The time it was collected, on every layout

All four TRMNL sizes are included (`full`, `half_horizontal`, `half_vertical`,
`quadrant`), so the screen works inside a mashup as well as on its own.

**This screen is desktop-only** — it reads `~/.claude/projects`, which mobile
Obsidian can't. It's skipped on mobile rather than failing there. A screen you
write that only reads the vault will run everywhere; see AGENTS.md for how to
flip the manifest if you drop this one.

## Why an Obsidian plugin

Mostly because Obsidian is already running. It gives you a cross-platform host
process with a settings UI, a scheduler, and a place to keep configuration —
none of which you want to hand-roll as a daemon for one small screen. Your vault
is also, conveniently, full of things worth putting on a wall.

## Setup

1. Install the plugin and enable it.
2. On trmnl.com, create a **private plugin** with strategy **Webhook**. Copy its
   UUID.
3. Paste the four files from `templates/claude-usage/` into that plugin's markup
   editor — one per size.
4. In the plugin's settings tab, enable the screen and paste the UUID.
5. Run **Push all enabled screens now** from the command palette.

Each screen is its own private plugin with its own UUID — TRMNL's playlist
rotates plugin *instances*, so two screens can't share one.

## A note on freshness

Pushes stop while the machine is asleep. A closed laptop means the panel keeps
showing whatever it last received, which is why the collection time appears on
every layout: an hours-old block total that looks live is worse than no screen
at all.

## Building

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/trmnl-claude-usage/`.

---

## Security

**Read this before you put a credential in the settings tab.** How exposed it is
depends entirely on how *your* vault is set up, and this plugin cannot control
that.

### What's stored, and where

Everything you type into the settings tab is written in **plaintext** to:

```
<your vault>/.obsidian/plugins/trmnl-claude-usage/data.json
```

That includes your TRMNL webhook UUID, and any API key a screen you add needs.
Obsidian has no secret store and no OS keychain integration — every plugin's
settings are a plain JSON file inside your vault. The settings fields are masked
in the UI, but that only stops shoulder-surfing and screenshots. It is not
encryption.

### A webhook UUID is a bearer credential

Anyone holding it can POST to your display. There is no second factor, no
signature, no origin check — the URL *is* the authentication. Treat it like a
password:

- Don't commit it. `data.json` is gitignored here; check that's true wherever
  you keep your vault.
- Don't screenshot the settings tab. This is the realistic leak: you hit a
  problem, you screenshot the panel to ask for help. Fields are masked to make
  that survivable, but reveal one and forget, and it's in the image.
- Rotate it by deleting and recreating the private plugin on trmnl.com if you
  think it's been seen.

The blast radius is real but bounded: someone can write nonsense to your screen.
They cannot read your vault or your account through it.

### Where your setup changes the risk

| Your setup | What it means for `data.json` |
|---|---|
| **Obsidian Sync** | Config sync is opt-in per category. If plugin settings are included, your credentials travel to every synced device and through Obsidian's servers. |
| **iCloud / Dropbox / Google Drive** | Credentials sit in a third party's storage, in plaintext, under whatever retention and sharing that provider applies. Check the folder isn't in a shared drive. |
| **Git-backed vault** | One `git add -A` with a missing `.gitignore` publishes the file. If your vault repo is public, assume compromise and rotate immediately — and remember history keeps it after deletion. |
| **Shared or work machine** | Any user who can read your vault directory can read the file. There are no filesystem permissions beyond whatever your vault folder already has. |
| **Backups** | Plaintext credentials are in every snapshot, including ones you can't easily purge. |

### Other plugins can read it

Obsidian's plugin API doesn't sandbox plugins from each other's data. Any other
community plugin you install can read this plugin's `data.json` — and this one
could read theirs. That's true across the whole ecosystem, not specific to this
plugin, but it's worth knowing before you paste a high-value API key into *any*
Obsidian plugin.

### If you add screens that need real credentials

The built-in Claude usage screen needs nothing but a webhook UUID. If you write
a screen that talks to an API:

- Prefer **read-only, narrowly-scoped** tokens. A stats-read key is a much
  smaller problem in a synced plaintext file than an account-wide token.
- Prefer a token you can **rotate cheaply** and that has an expiry.
- Mask the field with the existing `secret()` helper.
- Consider whether the data could be fetched elsewhere and written into a note,
  so the credential never enters your vault config at all.

### What this plugin sends, and where

Outbound requests go to exactly one place: `https://trmnl.com/api/custom_plugins/<your-uuid>`,
carrying only the merge variables your screen's `collect()` returned. No
telemetry, no analytics, no other endpoints. The Claude usage collector reads
`~/.claude/projects` locally and sends only aggregate token counts — never
prompts, responses, or file contents.

## License

MIT
