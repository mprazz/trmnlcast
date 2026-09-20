import { App, Notice, Platform, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { TextComponent } from "obsidian";
import { Budget, FREE_PAYLOAD_BYTES, FREE_PUSHES_PER_HOUR, encode, push } from "./push";
import type { Screen } from "./screens/types";
import { claudeUsage } from "./screens/claude-usage";
import * as secrets from "./secrets";

interface ScreenConfig {
  /** Private-plugin webhook UUID. A bearer credential — never leaves data.json. */
  uuid: string;
  enabled: boolean;
  lastDigest?: string;
  /** Minutes between pushes for this screen. Falls back to Screen.defaultEvery. */
  everyMinutes?: number;
  /** Epoch ms of the last successful push, so the scheduler survives a reload. */
  lastPushAt?: number;
}

interface Settings {
  screens: Record<string, ScreenConfig>;
  pushesPerHour: number;
  maxBytes: number;
  budgetStamps: number[];
}

const DEFAULTS: Settings = {
  screens: {},
  pushesPerHour: FREE_PUSHES_PER_HOUR,
  maxBytes: FREE_PAYLOAD_BYTES,
  budgetStamps: [],
};

export default class TrmnlClaudeUsage extends Plugin {
  settings!: Settings;
  budget!: Budget;
  screens: Screen[] = [];
  private status!: HTMLElement;
  private lastLine = "TRMNL: idle";

  async onload() {
    await this.loadSettings();
    this.screens = [claudeUsage];
    this.budget = Budget.from(this.settings.pushesPerHour, this.settings.budgetStamps);

    this.status = this.addStatusBarItem();
    this.paint();

    this.addSettingTab(new TrmnlSettingTab(this.app, this));

    this.addCommand({
      id: "push-now",
      name: "Push all enabled screens now",
      callback: () => void this.pushAll(true),
    });

    this.addCommand({
      id: "preview-payload",
      name: "Preview payloads (size check)",
      callback: () => void this.preview(),
    });

    // One slow ticker; each screen decides for itself whether it is due. There
    // is deliberately no vault listener: this screen reads ~/.claude, not the
    // vault, so waking on every note edit would re-read the transcript
    // directory for a payload that is then digest-skipped anyway.
    this.registerInterval(window.setInterval(() => void this.pushDue(), 60_000));

    this.app.workspace.onLayoutReady(() => void this.pushDue());
  }

  async pushDue() {
    for (const screen of this.due(Date.now())) {
      await this.pushAll(false, screen.id);
    }
  }

  configFor(id: string): ScreenConfig {
    if (!this.settings.screens[id]) {
      this.settings.screens[id] = { uuid: "", enabled: false };
    }
    return this.settings.screens[id];
  }

  /**
   * Enabled screens with a UUID — the ones that actually spend budget.
   *
   * Desktop-only screens drop out on mobile here, at the scheduler, so they
   * are never collected and never raise an error. Letting `collect` throw instead
   * turns "this device cannot run this screen" into an hourly notification,
   * which is noise, not information.
   */
  activeScreens(): Screen[] {
    return this.screens.filter((s) => {
      if (s.desktopOnly && Platform.isMobile) return false;
      return this.configFor(s.id).enabled && this.uuidFor(s.id).value.length > 0;
    });
  }

  /**
   * The webhook UUID in force for a screen, and where it came from. Resolved
   * on every use rather than cached at load: an env var or the external file
   * can change without Obsidian restarting, and a stale cache would send to
   * the old destination with no indication why.
   */
  uuidFor(id: string): secrets.Resolved {
    return secrets.resolve(id, this.configFor(id).uuid);
  }

  everyFor(screen: Screen): number {
    const v = this.configFor(screen.id).everyMinutes;
    return typeof v === "number" && v >= 1 ? v : screen.defaultEvery;
  }

  /** Pushes per hour if every screen fired exactly on its own schedule. */
  projectedPerHour(): number {
    return this.activeScreens().reduce((n, s) => n + 60 / this.everyFor(s), 0);
  }

  /**
   * Screens whose own interval has elapsed. Checked once a minute; a screen
   * that is not due costs nothing, so a slow screen never holds up a fast one
   * and the shared budget is spent on the data that actually moves.
   */
  private due(now: number): Screen[] {
    return this.activeScreens().filter((s) => {
      const last = this.configFor(s.id).lastPushAt ?? 0;
      return now - last >= this.everyFor(s) * 60_000;
    });
  }

  /**
   * `manual` reports outcomes as notices; the timer stays silent unless it
   * fails. `only` restricts the run to one screen — testing one screen should
   * cost one push out of the hourly twelve, not one per enabled screen.
   */
  async pushAll(manual: boolean, only?: string) {
    // Goes through activeScreens() rather than re-deriving the predicate, so
    // the mobile and enabled/UUID rules cannot drift between the scheduler and
    // a manual push.
    const active = this.activeScreens().filter((s) => !only || s.id === only);

    if (active.length === 0) {
      if (manual) {
        const blocked = this.screens.some((s) => s.desktopOnly && Platform.isMobile);
        new Notice(
          blocked
            ? "TRMNL: every enabled screen needs a desktop — nothing to push from mobile."
            : "TRMNL: no screen is enabled with a webhook UUID.",
        );
      }
      return;
    }

    let sent = 0;
    let failed = 0;

    for (const screen of active) {
      const cfg = this.configFor(screen.id);
      let vars: Record<string, unknown>;
      try {
        vars = await screen.collect(this.app);
      } catch (e) {
        failed++;
        this.lastLine = `TRMNL: ${screen.id} collect failed`;
        new Notice(`TRMNL — ${screen.label} could not collect: ${msg(e)}`);
        continue;
      }

      const res = await push(this.uuidFor(screen.id).value, vars, {
        budget: this.budget,
        lastDigest: cfg.lastDigest,
        maxBytes: this.settings.maxBytes,
      });

      if (res.ok && !res.skipped) {
        sent++;
        cfg.lastDigest = res.digest;
        cfg.lastPushAt = Date.now();
        this.lastLine = `TRMNL: ${screen.label} ${timeNow()} · ${res.bytes}B`;
      } else if (res.skipped === "unchanged") {
        // Nothing was sent, but the screen was checked — without this it would
        // come up due again every minute and re-collect forever.
        cfg.lastPushAt = Date.now();
        if (manual) new Notice(`TRMNL — ${screen.label} unchanged, nothing sent.`);
      } else if (res.skipped === "budget") {
        failed++;
        this.lastLine = "TRMNL: hourly budget spent";
        new Notice(
          `TRMNL — hourly budget spent (${this.settings.pushesPerHour}/h). Next slot in ${Math.ceil(this.budget.waitMs() / 60_000)} min.`,
        );
      } else {
        failed++;
        this.lastLine = `TRMNL: ${screen.label} failed`;
        // Always surface: a stale screen you trust is worse than a blank one.
        new Notice(`TRMNL — ${screen.label} failed: ${res.error ?? "unknown error"}`);
      }
    }

    this.settings.budgetStamps = this.budget.serialize();
    await this.saveSettings();
    this.paint();

    if (manual && failed === 0 && sent > 0) {
      new Notice(`TRMNL — pushed ${sent} screen${sent === 1 ? "" : "s"}.`);
    }
  }

  async preview() {
    const lines: string[] = [];
    for (const screen of this.screens) {
      if (screen.desktopOnly && Platform.isMobile) {
        lines.push(`${screen.label}: skipped — desktop only`);
        continue;
      }
      try {
        const vars = await screen.collect(this.app);
        const { bytes } = encode(vars);
        const flag = bytes > this.settings.maxBytes ? " ✗ OVER" : bytes > this.settings.maxBytes * 0.9 ? " ⚠ tight" : "";
        lines.push(`${screen.label}: ${bytes}B / ${this.settings.maxBytes}B${flag}`);
        console.log(`[trmnl-claude-usage] ${screen.id}`, vars);
      } catch (e) {
        lines.push(`${screen.label}: collect failed — ${msg(e)}`);
      }
    }
    new Notice(`TRMNL payloads\n${lines.join("\n")}\n\nFull JSON in the developer console.`, 12_000);
  }

  paint() {
    const left = this.budget.remaining();
    this.status.setText(`${this.lastLine} · ${left}/${this.settings.pushesPerHour} left`);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Two screens pointing at one UUID is silently destructive: both POST to the
 * same plugin and whichever pushed last wins, so the display shows one screen's
 * data under the other's template. Cheap to detect, so say so rather than let
 * it look like a rendering bug.
 */
function warnOnDuplicateUuids(plugin: TrmnlClaudeUsage, el: HTMLElement) {
  const seen = new Map<string, string[]>();
  for (const screen of plugin.screens) {
    // The resolved value, not the vault one — a clash between an env var and a
    // stored UUID is exactly as destructive and exactly as invisible.
    const uuid = plugin.uuidFor(screen.id).value;
    if (!uuid) continue;
    const list = seen.get(uuid) ?? [];
    list.push(screen.label);
    seen.set(uuid, list);
  }
  const clashes = [...seen.values()].filter((names) => names.length > 1);
  el.setText(
    clashes.length === 0
      ? ""
      : clashes.map((names) => `⚠ ${names.join(" and ")} share a webhook UUID — they will overwrite each other.`).join(" "),
  );
}

/**
 * Mask a settings field holding a credential.
 *
 * Not paranoia about someone reading over your shoulder: the settings tab is
 * the thing you screenshot when asking for help with it, and that is exactly
 * how an API key has leaked before. A webhook UUID is a bearer credential —
 * anyone holding it can write to your display — so every field carrying one
 * is masked.
 *
 * `type="password"` still pastes and still reveals via the browser's own
 * controls — it only keeps the value out of a casual capture of the window.
 */
function secret(t: TextComponent): TextComponent {
  t.inputEl.type = "password";
  t.inputEl.autocomplete = "off";
  return t;
}

function timeNow(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

class TrmnlSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TrmnlClaudeUsage) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      text:
        "Each screen is its own private plugin on trmnl.com, so each one needs its own webhook UUID — " +
        "the playlist rotates plugin instances, not templates within one.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Account limits")
      .setDesc(
        "Free: 12 pushes/hour, 5120 bytes. TRMNL+: 30 and 10240. The limit is per TRMNL account and " +
          "shared with anything else pushing to it, including Home Assistant's sensor-push.",
      )
      .addDropdown((d) =>
        d
          .addOption("free", "Free — 12/h, 5 kB")
          .addOption("plus", "TRMNL+ — 30/h, 10 kB")
          .setValue(this.plugin.settings.pushesPerHour > 12 ? "plus" : "free")
          .onChange(async (v) => {
            const plus = v === "plus";
            this.plugin.settings.pushesPerHour = plus ? 30 : 12;
            this.plugin.settings.maxBytes = plus ? 10240 : 5120;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    containerEl.createEl("h3", { text: "Screens" });

    for (const screen of this.plugin.screens) {
      const cfg = this.plugin.configFor(screen.id);

      const box = containerEl.createDiv({ cls: "trmnl-screen-box" });
      box.createEl("h4", { text: screen.label, cls: "trmnl-screen-title" });

      const unavailable = !!screen.desktopOnly && Platform.isMobile;
      if (unavailable) {
        // Say it once, here, instead of failing every push. The settings stay
        // editable so the UUID can be pasted on whichever device is to hand.
        box.createEl("div", {
          cls: "setting-item-description trmnl-warn",
          text:
            "This screen needs a desktop — it reads files outside the vault. It is skipped on " +
            "this device and will push normally from your computer.",
        });
      }

      new Setting(box)
        .setName("Enabled")
        .setDesc(screen.blurb)
        .addToggle((t) =>
          t.setValue(cfg.enabled).onChange(async (v) => {
            cfg.enabled = v;
            await this.plugin.saveSettings();
          }),
        );

      const resolved = this.plugin.uuidFor(screen.id);

      const uuidSetting = new Setting(box)
        .setName(`${screen.label} — webhook UUID`)
        .setDesc("The UUID from THIS screen's own private plugin on trmnl.com. It is a bearer credential: anyone holding it can write to your display.");

      if (resolved.source === "env") {
        // An env var wins over anything typed here, so offering a text box
        // would be a lie — edits would save and then be ignored.
        uuidSetting.setDesc(
          `${uuidSetting.descEl.getText()} Currently supplied by $${secrets.envVarName(screen.id)}; ` +
            `unset it to edit the value here.`,
        );
      } else {
        uuidSetting.addText((t) =>
          secret(t)
            .setPlaceholder(resolved.source === "file" ? "set in the external credentials file" : `UUID for "${screen.label}"`)
            .setValue(resolved.source === "file" ? "" : cfg.uuid)
            .setDisabled(resolved.source === "file")
            .onChange(async (v) => {
              cfg.uuid = v.trim();
              // A new destination invalidates the "already sent this" cache.
              cfg.lastDigest = undefined;
              await this.plugin.saveSettings();
              warnOnDuplicateUuids(this.plugin, dupe);
            }),
        );
      }

      const where = box.createEl("div", { cls: "setting-item-description" });
      where.setText(secrets.describe(resolved.source, screen.id));
      where.toggleClass("trmnl-warn", resolved.source === "vault");

      if (resolved.source === "vault") {
        new Setting(box)
          .setName("Move out of the vault")
          .setDesc(
            `Writes it to ${secrets.credentialsPath() ?? "the OS config directory"} with 0600 permissions and ` +
              "clears it from data.json, so it stops travelling with your notes through Sync, git and backups.",
          )
          .addButton((b) =>
            b.setButtonText("Move").setCta().onClick(async () => {
              try {
                const file = secrets.writeExternal(screen.id, cfg.uuid);
                // Only clear the vault copy once the write has actually
                // succeeded — the reverse order loses the credential entirely
                // if the disk write fails.
                cfg.uuid = "";
                await this.plugin.saveSettings();
                new Notice(`TRMNL — moved to ${file}. Keep a copy: nothing else has it now.`, 10_000);
                this.display();
              } catch (e) {
                new Notice(`TRMNL — could not write the credentials file: ${msg(e)}. Nothing was changed.`, 10_000);
              }
            }),
          );
      }

      new Setting(box)
        .setName("Refresh every")
        .setDesc(
          `Minutes between pushes for this screen. Default ${screen.defaultEvery} — set it to how fast ` +
            `the data really changes, not how often you want to look.`,
        )
        .addText((t) =>
          t
            .setPlaceholder(String(screen.defaultEvery))
            .setValue(cfg.everyMinutes ? String(cfg.everyMinutes) : "")
            .onChange(async (v) => {
              const num = Number(v);
              cfg.everyMinutes = v.trim() === "" ? undefined : Number.isFinite(num) && num >= 1 ? Math.round(num) : cfg.everyMinutes;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(box)
        .setName("Push this screen")
        .setDesc("Sends only this screen — one push out of the hourly budget, not one per enabled screen.")
        .addButton((b) =>
          b.setButtonText("Push").onClick(async () => {
            await this.plugin.pushAll(true, screen.id);
            this.display();
          }),
        );

      const size = box.createEl("div", { cls: "setting-item-description" });
      if (unavailable) {
        size.setText("Payload size: not measurable on this device.");
        continue;
      }
      size.setText("Payload size: measuring…");
      void screen
        .collect(this.plugin.app)
        .then((vars) => {
          const { bytes } = encode(vars);
          const max = this.plugin.settings.maxBytes;
          size.setText(`Payload size: ${bytes} / ${max} bytes${bytes > max ? " — OVER LIMIT, trim the collector" : ""}`);
          // Tri-state, so both classes are set explicitly rather than only the
          // one that applies — this element is re-measured in place.
          size.toggleClass("trmnl-error", bytes > max);
          size.toggleClass("trmnl-warn", bytes <= max && bytes > max * 0.9);
        })
        .catch((e) => size.setText(`Payload size: collect failed — ${msg(e)}`));
    }

    const dupe = containerEl.createEl("div", { cls: "setting-item-description trmnl-error" });
    warnOnDuplicateUuids(this.plugin, dupe);

    const n = this.plugin.activeScreens().length;
    const perHour = this.plugin.projectedPerHour();
    const limit = this.plugin.settings.pushesPerHour;

    const budget = new Setting(containerEl)
      .setName("Push all now")
      .setDesc(
        `${n} screen${n === 1 ? "" : "s"} enabled, scheduled at about ${perHour.toFixed(1)} pushes/hour ` +
          `against a limit of ${limit}. ${this.plugin.budget.remaining()} left this hour. ` +
          `Pushing all sends up to ${n} at once — use a screen's own Push button while iterating on one.`,
      )
      .addButton((b) => b.setButtonText("Push all").setCta().onClick(() => void this.plugin.pushAll(true)));

    if (perHour > limit) {
      budget.descEl.createEl("div", {
        cls: "trmnl-error",
        text: `⚠ Scheduled rate exceeds the hourly limit — slow down a screen's refresh, or some will be skipped.`,
      });
    }
  }
}
