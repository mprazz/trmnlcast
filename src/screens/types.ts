import type { App } from "obsidian";

/**
 * One TRMNL screen. Each screen is its own private plugin instance on
 * trmnl.com — that is not an implementation detail we chose, it's how the
 * playlist works: TRMNL rotates *plugin instances*, so two screens that
 * should appear separately in the rotation cannot share one UUID.
 *
 * This plugin ships one screen, but the registry is deliberately still a list:
 * adding a second means writing a `collect` and appending it in `main.ts`, and
 * the budget, digest-skip and settings UI come along for free.
 *
 * `collect` returns whatever the Liquid template expects. Keep it small: the
 * whole serialized body has to fit in 5 kB (10 kB on TRMNL+).
 */
export interface Screen {
  id: string;
  /** Shown in the settings tab. */
  label: string;
  /** One line explaining what lands on the display. */
  blurb: string;
  /**
   * Default refresh, in minutes. Set it to how fast the underlying data
   * actually changes, not to how often you would like to look at it: a push
   * that sends an identical payload is skipped anyway, and the hourly budget
   * is shared with every other screen on the account.
   */
  defaultEvery: number;
  /**
   * Set when `collect` needs something mobile Obsidian does not have —
   * `require("fs")`, a path outside the vault, a child process. The scheduler
   * skips these on mobile *silently* rather than letting `collect` throw: a
   * screen that cannot possibly work on this device is not a failure worth a
   * notification every minute.
   *
   * A screen that only reads the vault does not need this and will run
   * everywhere.
   */
  desktopOnly?: boolean;
  collect(app: App): Promise<Record<string, unknown>>;
}
