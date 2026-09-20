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
  collect(app: App): Promise<Record<string, unknown>>;
}
