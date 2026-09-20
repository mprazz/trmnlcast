# Adding a screen — a guide for coding agents

This plugin ships one screen (Claude Code usage), but the machinery around it is
generic. Adding a second is roughly 80 lines of TypeScript plus four Liquid
templates, and the budget accounting, duplicate-UUID guard, payload-size meter
and settings UI all come along for free.

This file is written for an LLM doing that work. Everything below was learned by
putting markup on a real panel and finding it wrong — the TRMNL docs disagree
with the platform in several places, and where they do, **the live settings form
and the markup linter win.**

## The shape of a screen

A screen is one object implementing `Screen` (`src/screens/types.ts`):

```ts
import type { Screen } from "./types";

export const myScreen: Screen = {
  id: "my-screen",
  label: "My screen",
  blurb: "One line describing what lands on the display.",
  defaultEvery: 360,
  async collect(app) {
    return { headline: "42", as_of: "14:05", as_of_epoch: Math.floor(Date.now() / 1000) };
  },
};
```

Register it in `src/main.ts`:

```ts
this.screens = [claudeUsage, myScreen];
```

That is the whole integration. Do not add a settings field, a timer or a push
call — the registry handles all three.

## Rules that are not negotiable

**One screen is one private plugin on trmnl.com, with its own webhook UUID.**
TRMNL's playlist rotates *plugin instances*, not templates inside one instance.
Two screens sharing a UUID overwrite each other and the display shows one
screen's data under the other's template. The settings tab warns about this;
don't design around sharing.

**The payload must fit 5120 bytes (10240 on TRMNL+).** `docs.trmnl.com` says
2 kB / 5 kB and is out of date. Keep collectors lean anyway — short keys,
pre-formatted strings, no nested objects you don't render. The settings tab
shows live byte count per screen.

**`collect` must throw, not return zeros.** A screen that silently reports `0`
when its source is unreachable is worse than one that says it failed: the
failure becomes invisible and you trust a dead number. Throw with a message that
names what was unreadable.

**Pick `defaultEvery` from how fast the data changes, not how often you want to
look.** The hourly budget (see below) is the scaling limit, and an unchanged
payload is skipped anyway, so a fast interval on slow data buys nothing.

## The hourly push budget

12 pushes/hour on free accounts, 30 on TRMNL+. **Per account**, not per plugin —
shared by every screen here and by anything else pushing to the same TRMNL
account (Home Assistant's `trmnl-sensor-push`, for instance).

This means push count scales with *screen count*, not with how often data
changes. Four screens on a 15-minute timer want 16 pushes/hour against a ceiling
of 12. The budget guard absorbs the overflow, but "absorbs" means screens at the
end of the list starve while the ones at the front always win. **A guard is not a
schedule.** Give each screen an interval that fits.

Two behaviours worth knowing before you change them:

- An unchanged payload is digest-skipped but **still stamps `lastPushAt`**.
  Without that, a screen whose data never changes comes up due every minute and
  re-collects forever.
- "Push all" costs one slot per enabled screen. Each screen has its own Push
  button; use it while iterating on one screen's markup.

## Writing the markup

Four sizes live in `templates/<screen-id>/`: `full`, `half_horizontal`,
`half_vertical`, `quadrant`. They are not auto-deployed — paste them into the
private plugin's markup editor on trmnl.com.

Write all four. TRMNL mashups combine two plugins into one split screen, and a
plugin in a mashup renders its **half** markup, not its full one.

### Corrections against the published docs

- **Do not wrap markup in `<div class="view view--full">`.** The platform adds
  that wrapper and the linter rejects yours. Start at `<div class="layout">`,
  with `<div class="title_bar">` as a *sibling after* it.
- **Proportional splits use `grid` + `col--span-N`** (12-column), not `columns`.
  `columns` distributes many items of the same type; two panels of different
  content is a grid.
- **Muted text must use `label--gray`, never CSS `color: gray`.** On 1-bit the
  framework renders gray as a tiled pattern clipped to the glyph. A plain CSS
  color disappears entirely.

### Layout traps found by screenshot, not by reading

Every one of these looked correct in the markup and wrong on the panel.
**Screenshot each size before calling it done.**

| Trap | What you see | Fix |
|---|---|---|
| No `.layout` stacks its children | Labels and values run together on one line | Wrap in `flex flex--col`, every time |
| `col--span-N` outside a `.grid` | Spans ignored, content centred full-width | The 12-column system keys off `.grid` |
| `flex flex--col` centres by default | One column centred beside a left-aligned one | Add `flex--left` |
| Grid cells do not clip | An oversized value overlaps its neighbour | Size to the cell, or `data-fit-value="true"` |

`value--tnums` handles non-numeric strings fine — `17:00` keeps its colon.

### Say how old the data is

A webhook screen shows whatever was last pushed, and pushes stop dead when the
machine sleeps — a suspended laptop leaves hours-old numbers on the glass
looking perfectly current. Emit `as_of` (local `HH:MM`, stamped at collection)
and render it in the title bar of **every** size. It costs a few bytes and it is
the difference between a stale screen and a lying one.

Be careful which values survive staleness. An absolute time (`resets_at: 17:00`)
stays true at any age. A relative one (`4h 30m left`) is wrong the moment it
goes stale, and anything divided by elapsed time (a per-minute rate) is worse.

Note that a wall-clock guard inside Liquid mostly cannot help here: TRMNL
regenerates a screen only when the merge variables change, so with no push there
is no re-render and Liquid's `"now"` never advances. The timestamp stamped at
push time is what does the work.

## Before you commit

```bash
npm run build     # tsc --noEmit then esbuild
```

- Never commit `data.json`. It holds webhook UUIDs, which are bearer
  credentials — anyone with one can write to the display. It is gitignored;
  keep it that way.
- Mask any new settings field holding a credential with the existing `secret()`
  helper. The settings tab is the thing people screenshot when asking for help.
- Keep templates in step with the collector. Liquid renders an unknown variable
  as the empty string, so renaming a field in `collect` without updating the
  markup does not error — the line just silently vanishes from the panel.
  Nothing in the toolchain checks this.
