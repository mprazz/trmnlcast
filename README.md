# Claude Usage for TRMNL

An Obsidian plugin that puts your Claude Code token usage on a [TRMNL](https://trmnl.com)
e-ink display.

It reads your local Claude Code transcripts, works out where you are in the
current five-hour usage block, and pushes a small summary to a TRMNL private
plugin over its webhook. No API key, no third-party service, no `npx` — the
numbers come from files already on your disk.

![placeholder: photo of the panel showing the full layout](docs/panel.jpg)

## What lands on the display

- When the current usage block resets, and roughly how long is left
- Tokens used this block, and the current burn rate per minute
- Today's total, split by model
- The time it was collected, on every layout

## Why it's an Obsidian plugin

Mostly because Obsidian is already running. It gives you a cross-platform host
process with a settings UI, a scheduler and a place to keep credentials, none of
which you want to hand-roll as a daemon for one small screen. If you don't use
Obsidian, this probably isn't the tool for you.

**Desktop only.** It reads `~/.claude/projects` directly, which mobile Obsidian
cannot do.

## Setup

1. Install the plugin and enable it.
2. On trmnl.com, create a **private plugin** with strategy **Webhook**. Copy its
   UUID.
3. Paste the four files from `templates/claude-usage/` into that plugin's markup
   editor — one per size.
4. In the plugin's settings tab in Obsidian, enable the screen and paste the
   UUID.
5. Run **Push all enabled screens now** from the command palette.

Your webhook UUID is a bearer credential: anyone who has it can write to your
display. It lives in `data.json`, which is gitignored, and the settings field is
masked. Don't paste it into a screenshot.

## Push budget

TRMNL allows **12 pushes/hour on free accounts, 30 on TRMNL+**, counted **per
account** and shared with anything else pushing to it. The plugin tracks this in
a sliding window, skips pushes whose payload hasn't changed, and shows what's
left in the status bar. Set your tier in settings so the accounting matches.

The default interval is 60 minutes, which is one push an hour against that
ceiling.

## A note on freshness

Pushes stop while the machine is asleep. A closed laptop means the panel keeps
showing whatever it last received, which is why the collection time appears on
every layout — an hours-old block total that looks live is worse than no screen
at all.

## Adding your own screens

The push machinery is generic: a screen is one object with a `collect()` that
returns merge variables, plus four Liquid templates. Register it in an array and
the budget accounting, size meter and settings UI come with it.

[AGENTS.md](AGENTS.md) is a full guide to doing that, written for coding agents
but perfectly readable by humans. It includes the TRMNL layout traps that cost
real time to find — several places where the published docs disagree with the
platform.

## Building

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/trmnl-claude-usage/`.

## License

MIT
