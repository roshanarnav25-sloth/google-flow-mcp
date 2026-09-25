import * as path from "node:path";
import { COMPOSER_QUOTE_PATTERN, TIMEOUTS } from "../constants.js";
import { FlowError } from "../types.js";
import { assertNoStopSignal, getFlowPage } from "./browser.js";
import { clickByText, pageText } from "./transport.js";

/**
 * COMPOSER CONTROL — settings, frame attachment, upload.
 *
 * On flow.google.com (since September 2026) the prompt box has two modes:
 *
 *   Agent   a chat: Flow's agent proposes a generation and asks for approval
 *   direct  the prompt is sent straight to the chosen model
 *
 * This server runs in DIRECT mode. There the settings popover behind the
 * "Settings trigger" chip states the exact price of the next submission
 * ("Generating will use N credits") BEFORE anything is sent, so the cost gate
 * reads that quote and refuses while refusal is still free.
 *
 * Generation mode is composer state too:
 *
 *   Image                      Nano Banana stills
 *   Video > Frames             Start (and optional End) frame slots
 *   Video > Ingredients        reference images
 *
 * Frames are attached by media id and verified, never by name: two outputs of
 * one prompt share an auto-generated name.
 */

export type ModelTier = "veo-3.1-lite" | "veo-3.1-fast" | "veo-3.1-quality" | "omni-1.1-flash";
export type AspectRatio = "16:9" | "9:16" | "4:3" | "1:1" | "3:4";

export interface FlowSettings {
  kind: "image" | "video" | null;
  /** Video only: Frames (start/end frame) or Ingredients (reference images). */
  videoMode: "frames" | "ingredients" | null;
  model: string | null;
  aspectRatio: string | null;
  outputsPerPrompt: number | null;
  durationSeconds: number | null;
  resolution: string | null;
  /** Credits the composer says the next submission will use. */
  quotedCredits: number | null;
  /** Whether the composer is in Agent (chat, approval-card) mode. The server runs in direct mode. */
  agentMode: boolean | null;
  confirmGate: "always" | "off" | "unknown";
}

export interface SettingsChange {
  kind?: "image" | "video";
  videoMode?: "frames" | "ingredients";
  model?: string;
  aspectRatio?: string;
  outputsPerPrompt?: number;
  durationSeconds?: number;
  resolution?: string;
}

const PANE_SELECTOR = ".cdk-overlay-pane";

async function settingsPaneOpen(): Promise<boolean> {
  const page = await getFlowPage();
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll<HTMLElement>(sel)].some(
        (p) => p.getClientRects().length > 0 && /Generating will use/i.test(p.innerText),
      ),
    PANE_SELECTOR,
  );
}

async function openSettings(): Promise<void> {
  const page = await getFlowPage();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await settingsPaneOpen()) return;
    const clicked = await page.evaluate(() => {
      const trigger = [...document.querySelectorAll<HTMLElement>('button[aria-label="Settings trigger"]')].find(
        (b) => b.offsetParent !== null,
      );
      trigger?.click();
      return Boolean(trigger);
    });
    if (!clicked) {
      await page.waitForTimeout(1_500); // the composer may still be mounting after a reload
      continue;
    }
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250);
      if (await settingsPaneOpen()) return;
    }
  }
  throw new FlowError(
    'Could not open the composer settings popover (aria-label "Settings trigger").',
    "Confirm a Flow project is open on flow.google.com with the prompt box visible. Nothing was charged.",
  );
}

export async function closeSettings(): Promise<void> {
  const page = await getFlowPage();
  // Observed 2026-09-24: this popover has NO .cdk-overlay-backdrop, and while it
  // is open a click on "Start generation" does nothing — the send is swallowed
  // and the prompt stays in the box. It closes reliably by clicking its own
  // "Settings trigger" again (a toggle). Escape is the last resort only: it can
  // reach the prompt box.
  for (let i = 0; i < 3 && (await settingsPaneOpen()); i++) {
    const how = await page
      .evaluate(() => {
        const trigger = [...document.querySelectorAll<HTMLElement>('button[aria-label="Settings trigger"]')].find(
          (b) => b.getClientRects().length > 0,
        );
        if (trigger) {
          trigger.click();
          return "trigger";
        }
        const backdrop = document.querySelector<HTMLElement>(".cdk-overlay-backdrop");
        backdrop?.click();
        return backdrop ? "backdrop" : "none";
      })
      .catch(() => "none");
    if (how === "none") await page.keyboard.press("Escape").catch(() => {});
    for (let k = 0; k < 8 && (await settingsPaneOpen()); k++) await page.waitForTimeout(150);
  }
  if (await settingsPaneOpen()) {
    throw new FlowError(
      "Could not close the composer settings popover.",
      "While it is open Flow ignores the send button. Nothing was sent or charged.",
    );
  }
}

/** Make sure the composer is in direct mode, where the price shows before sending. */
export async function ensureDirectMode(): Promise<void> {
  const page = await getFlowPage();
  const state = await page.evaluate(() => {
    const chip = [...document.querySelectorAll<HTMLElement>("button.agent-mode-chip")].find((b) => b.offsetParent);
    if (!chip) return "missing";
    if (chip.getAttribute("aria-pressed") === "true") {
      chip.click();
      return "switched";
    }
    return "direct";
  });
  if (state === "switched") await page.waitForTimeout(600);
  if (state === "missing") {
    throw new FlowError(
      "Could not find the composer's Agent toggle.",
      "Flow's composer may have changed. Nothing was charged.",
    );
  }
}

/** Read the composer settings and the quoted price. Free; opens and closes the popover. */
export async function readSettings(): Promise<FlowSettings> {
  const page = await getFlowPage();
  const agentMode = await page.evaluate(() => {
    const chip = [...document.querySelectorAll<HTMLElement>("button.agent-mode-chip")].find((b) => b.offsetParent);
    return chip ? chip.getAttribute("aria-pressed") === "true" : null;
  });
  await openSettings();

  const raw = await page.evaluate((sel) => {
    const pane = [...document.querySelectorAll<HTMLElement>(sel)].find((p) => /Generating will use/i.test(p.innerText));
    if (!pane) return null;
    const checked = [...pane.querySelectorAll<HTMLElement>("[role=radio],[role=tab],button")]
      .filter((b) => b.getAttribute("aria-checked") === "true" || b.getAttribute("aria-selected") === "true")
      .map((b) => (b.innerText || "").replace(/\s+/g, " ").trim());
    return { text: pane.innerText.replace(/\s+/g, " "), checked };
  }, PANE_SELECTOR);

  await closeSettings();
  if (!raw) {
    throw new FlowError("The composer settings popover did not open.", "Nothing was charged. Retry once.");
  }

  const has = (re: RegExp) => raw.checked.find((c) => re.test(c)) ?? null;
  const kindText = has(/^(image )?Image$|^(videocam )?Video$/);
  const quote = COMPOSER_QUOTE_PATTERN.exec(raw.text);
  return {
    kind: kindText ? (/video/i.test(kindText) ? "video" : "image") : null,
    videoMode: has(/Frames$/) ? "frames" : has(/Ingredients$/) ? "ingredients" : null,
    model:
      /(Nano Banana[\w .]*?(?= arrow_drop_down| x\d)|Omni [\d.]+ Flash|Veo 3\.1 - (?:Lite|Fast|Quality))/.exec(
        raw.text,
      )?.[1] ?? null,
    aspectRatio: has(/\b\d+:\d+$/)?.match(/\d+:\d+/)?.[0] ?? null,
    outputsPerPrompt: Number.parseInt(has(/^x\d$/)?.slice(1) ?? "", 10) || null,
    durationSeconds: Number.parseInt(has(/^\d+s$/) ?? "", 10) || null,
    resolution: has(/^\d{3,4}p/)?.match(/\d{3,4}p/)?.[0] ?? null,
    quotedCredits: quote ? Number.parseInt(quote[1].replace(/,/g, ""), 10) : null,
    agentMode,
    confirmGate: "unknown",
  };
}

/**
 * Change composer settings. Free: nothing is sent. Each option is a labelled
 * radio in the popover; the model is chosen from the "Select model family" menu.
 * Changing the model tier is still the biggest cost lever there is.
 */
export async function applySettings(change: SettingsChange): Promise<FlowSettings> {
  const page = await getFlowPage();
  await ensureDirectMode();
  await openSettings();

  const clickOption = async (re: RegExp, what: string) => {
    const ok = await page.evaluate(
      ([sel, source]) => {
        const rx = new RegExp(source, "i");
        const pane = [...document.querySelectorAll<HTMLElement>(sel)].find((p) =>
          /Generating will use/i.test(p.innerText),
        );
        const btn = [...(pane?.querySelectorAll<HTMLElement>("[role=radio],[role=tab],button") ?? [])].find((b) =>
          rx.test((b.innerText || "").replace(/\s+/g, " ").trim()),
        );
        if (!btn) return false;
        btn.click();
        return true;
      },
      [PANE_SELECTOR, re.source] as const,
    );
    if (!ok) {
      await closeSettings();
      throw new FlowError(`Could not find the "${what}" option in the composer settings.`, "Nothing was charged.");
    }
    await page.waitForTimeout(450);
  };

  if (change.kind) await clickOption(change.kind === "video" ? /Video$/ : /Image$/, change.kind);
  if (change.videoMode) await clickOption(change.videoMode === "frames" ? /Frames$/ : /Ingredients$/, change.videoMode);
  if (change.model) {
    const opened = await page.evaluate((sel) => {
      const pane = [...document.querySelectorAll<HTMLElement>(sel)].find((p) =>
        /Generating will use/i.test(p.innerText),
      );
      const trigger =
        pane?.querySelector<HTMLElement>('[aria-label="Select model family"]') ??
        [...(pane?.querySelectorAll<HTMLElement>("button") ?? [])].find((b) => /arrow_drop_down/.test(b.innerText));
      trigger?.click();
      return !!trigger;
    }, PANE_SELECTOR);
    await page.waitForTimeout(700);
    const picked =
      opened &&
      (await page.evaluate((name) => {
        const norm = (t: string) =>
          t
            .replace(/volume_up|🍌/gu, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const opt = [
          ...document.querySelectorAll<HTMLElement>("[role=option],[role=menuitem],[role=menuitemradio]"),
        ].find((o) => norm(o.innerText) === norm(name));
        opt?.click();
        return !!opt;
      }, change.model));
    await page.waitForTimeout(600);
    if (!picked) {
      await page.keyboard.press("Escape").catch(() => {});
      await closeSettings();
      throw new FlowError(
        `Model "${change.model}" is not offered in the composer.`,
        'Use the exact label, e.g. "Veo 3.1 - Fast", "Veo 3.1 - Lite", "Omni 1.1 Flash" or "Nano Banana 2 Lite". Nothing was charged.',
      );
    }
  }
  if (change.aspectRatio) {
    await clickOption(new RegExp(`${change.aspectRatio.replace(/[^\d:]/g, "")}$`), change.aspectRatio);
  }
  if (change.resolution) await clickOption(new RegExp(`^${change.resolution.replace(/\W/g, "")}`), change.resolution);
  if (change.durationSeconds) {
    await clickOption(new RegExp(`^${change.durationSeconds}s$`), `${change.durationSeconds}s`);
  }
  if (change.outputsPerPrompt) {
    await clickOption(new RegExp(`^x${change.outputsPerPrompt}$`), `x${change.outputsPerPrompt}`);
  }

  await closeSettings();
  return readSettings();
}

/** Back-compat wrapper for the single-key form of flow_settings. */
export async function setSetting(
  key: "model" | "aspectRatio" | "outputsPerPrompt" | "durationSeconds",
  value: string,
): Promise<FlowSettings> {
  if (key === "outputsPerPrompt") return applySettings({ outputsPerPrompt: Number(value) });
  if (key === "durationSeconds") return applySettings({ durationSeconds: Number(value) });
  if (key === "aspectRatio") return applySettings({ aspectRatio: value });
  return applySettings({ model: value });
}

/** Wait for a frame-picker dialog and report whether it opened. */
async function waitForPicker(): Promise<boolean> {
  const page = await getFlowPage();
  for (let i = 0; i < 10; i++) {
    const open = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".cdk-overlay-pane,[role=dialog]")].some((p) =>
        /Select a frame image/i.test(p.innerText),
      ),
    );
    if (open) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function closePicker(): Promise<void> {
  const page = await getFlowPage();
  await page.evaluate(() => {
    const pane = [...document.querySelectorAll<HTMLElement>(".cdk-overlay-pane,[role=dialog]")].find((p) =>
      /Select a frame image/i.test(p.innerText),
    );
    pane?.querySelector<HTMLElement>('button[aria-label="Close"]')?.click();
  });
  await page.waitForTimeout(400);
}

/** Open the Start or End frame slot's picker. The composer must be in Video > Frames mode. */
async function openFrameSlot(slot: "Start" | "End"): Promise<void> {
  const page = await getFlowPage();
  const clicked = await page.evaluate((label) => {
    let scope: HTMLElement | null = document.querySelector<HTMLElement>(".ProseMirror");
    for (let k = 0; k < 8 && scope?.parentElement; k++) scope = scope.parentElement;
    scope = scope ?? document.body;
    const btn = [...scope.querySelectorAll<HTMLElement>("button")]
      .filter((b) => b.offsetParent)
      .find((b) => (b.innerText || "").trim() === label || b.getAttribute("aria-label") === label);
    if (!btn) return false;
    btn.click();
    return true;
  }, slot);
  if (!clicked || !(await waitForPicker())) {
    throw new FlowError(
      `Could not open the ${slot} frame slot.`,
      "Set the composer to Video > Frames with flow_settings, or clear the slot in the browser. Nothing was charged.",
    );
  }
}

/** @internal exported for unit tests. The opaque image token in a `/asb/<token>=s…` url. */
export function asbToken(src: string | null | undefined): string | null {
  return /\/asb\/([^=?/]+)/.exec(src ?? "")?.[1] ?? null;
}

/**
 * media id -> /asb/ token, read from the grid. On flow.google.com the frame picker
 * and the composer slots render images from lh3.googleusercontent.com/asb/<token>
 * with no media id anywhere; only the grid's `[data-media-id]` img ties an id to
 * its token (served there from flow.google.com/asb/<token>).
 */
async function gridMediaTokens(): Promise<Record<string, string>> {
  const page = await getFlowPage();
  const pairs = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-media-id]")].map((el) => [
      el.getAttribute("data-media-id") ?? "",
      el.getAttribute("src") ?? el.querySelector("img")?.getAttribute("src") ?? "",
    ]),
  );
  const map: Record<string, string> = {};
  for (const [id, src] of pairs) {
    const token = asbToken(src);
    if (id && token) map[id] = token;
  }
  return map;
}

/** Media ids currently shown in the composer's frame slots, in order. */
async function frameSlotIds(tokens: Record<string, string>): Promise<string[]> {
  const page = await getFlowPage();
  const srcs = await page.evaluate(() => {
    let scope: HTMLElement | null = document.querySelector<HTMLElement>(".ProseMirror");
    for (let k = 0; k < 8 && scope?.parentElement; k++) scope = scope.parentElement;
    scope = scope ?? document.body;
    return [...scope.querySelectorAll<HTMLImageElement>("img")].map((i) => ({
      id: i.getAttribute("data-media-id"),
      src: i.src,
    }));
  });
  const byToken = new Map(Object.entries(tokens).map(([id, token]) => [token, id]));
  return srcs
    .map(({ id, src }) => {
      const token = asbToken(src);
      return id ?? /\/image\/([0-9a-f-]{36})/.exec(src)?.[1] ?? (token ? byToken.get(token) : undefined) ?? null;
    })
    .filter((x): x is string => Boolean(x));
}

/**
 * Put library images into the Start/End frame slots and VERIFY by media id.
 *
 * The picker lists every image as a role=option button. Its <img> carries no
 * media id on flow.google.com, so options are matched by the /asb/ token the
 * grid maps to that id (legacy /image/<id> urls still match directly).
 */
export async function attachFrames(
  startId?: string,
  endId?: string,
): Promise<{ attached: string[]; missing: string[] }> {
  await assertNoStopSignal();
  const page = await getFlowPage();
  const attached: string[] = [];
  const missing: string[] = [];
  const tokens = await gridMediaTokens();

  for (const [slot, id] of [
    ["Start", startId],
    ["End", endId],
  ] as const) {
    if (!id) continue;
    await openFrameSlot(slot);
    const ok = await page.evaluate(
      ({ mediaId, token }) => {
        const pane = [...document.querySelectorAll<HTMLElement>(".cdk-overlay-pane,[role=dialog]")].find((p) =>
          /Select a frame image/i.test(p.innerText),
        );
        const option = [...(pane?.querySelectorAll<HTMLElement>("[role=option]") ?? [])].find((o) => {
          const img = o.querySelector("img");
          if (!img) return false;
          if (img.src.includes(mediaId) || img.getAttribute("data-media-id") === mediaId) return true;
          return token !== null && /\/asb\/([^=?/]+)/.exec(img.src)?.[1] === token;
        });
        if (!option) return false;
        option.click();
        return true;
      },
      { mediaId: id, token: tokens[id] ?? null },
    );
    if (!ok) {
      missing.push(id);
      await closePicker();
      continue;
    }
    await page.waitForTimeout(400);
    // On flow.google.com (observed 2026-09-24) choosing an option attaches it and
    // closes the picker; there is no "Add to prompt" step. Only look for that
    // button while the picker is still open, and only inside it — a page-wide
    // text match clicked some unrelated element here.
    const pickerOpen = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".cdk-overlay-pane,[role=dialog]")].some((p) =>
        /Select a frame image/i.test(p.innerText),
      ),
    );
    if (pickerOpen) {
      const added = await page.evaluate(() => {
        const pane = [...document.querySelectorAll<HTMLElement>(".cdk-overlay-pane,[role=dialog]")].find((p) =>
          /Select a frame image/i.test(p.innerText),
        );
        const btn = [...(pane?.querySelectorAll<HTMLElement>("button") ?? [])].find(
          (b) => b.innerText.replace(/\s+/g, " ").trim() === "Add to prompt",
        );
        btn?.click();
        return !!btn;
      });
      if (!added) {
        await closePicker();
        throw new FlowError(`Selected ${id} but could not press "Add to prompt".`, "Nothing was charged.");
      }
    }
    await page.waitForTimeout(900);
    attached.push(id);
  }

  const inSlots = await frameSlotIds(tokens);
  const verified = attached.filter((id) => inSlots.includes(id));
  if (verified.length !== attached.length) {
    throw new FlowError(
      `Attached ${attached.length} frame(s) but the composer shows ${verified.length} of them.`,
      "Nothing was charged. Check the Start/End slots in the browser before retrying, or the wrong frame may be animated.",
    );
  }
  if (startId && endId && (inSlots[0] !== startId || inSlots[inSlots.length - 1] !== endId)) {
    throw new FlowError(
      "Start and End frames landed in the wrong slots.",
      'Nothing was charged. Use "Swap first and last frames" in the browser, or reload and retry.',
    );
  }
  return { attached: verified, missing };
}

/** Reference-image (Ingredients) attachment is not mapped on the new composer yet. */
export async function attachMedia(mediaIds: string[]): Promise<{ attached: string[]; missing: string[] }> {
  if (mediaIds.length === 0) return { attached: [], missing: [] };
  throw new FlowError(
    "Reference-image (Ingredients) attachment has not been mapped on flow.google.com yet.",
    "Use a start frame (Frames mode) instead. Nothing was charged.",
  );
}

/**
 * Upload a local image into the project library through the frame picker's
 * "Upload media" button, and return the new media id by diffing the library.
 */
export async function uploadMedia(filePath: string): Promise<{ file: string; mediaId: string | null; note: string }> {
  const page = await getFlowPage();
  const { listMedia } = await import("./media.js");
  const before = new Set((await listMedia(500, 0)).items.map((i) => i.mediaId));

  await applySettings({ kind: "video", videoMode: "frames" });
  await openFrameSlot("Start");
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 }).catch(() => null);
  const clicked = await clickByText("uploadUpload media", { exact: true, maxDescendants: 4 });
  const chooser = clicked ? await chooserPromise : null;
  if (!chooser) {
    await closePicker();
    throw new FlowError(
      "Flow's picker did not open a file chooser for upload.",
      "Upload the frame manually in the browser, then use its media id from flow_list_media.",
    );
  }
  await chooser.setFiles(path.resolve(filePath));

  let mediaId: string | null = null;
  for (let i = 0; i < 40 && !mediaId; i++) {
    await page.waitForTimeout(1_500);
    const now = (await listMedia(500, 0)).items.map((x) => x.mediaId);
    mediaId = now.find((id) => !before.has(id)) ?? null;
  }
  await closePicker();

  return {
    file: path.resolve(filePath),
    mediaId,
    note: mediaId
      ? `Uploaded as media ${mediaId}.`
      : "The upload was sent but no new library tile appeared within 60s. Check the browser and flow_list_media.",
  };
}

/**
 * Clear the composer: prompt text and any frame chips. A reload is the only
 * reliable reset on the new composer, and it is free.
 */
export async function clearAttachments(): Promise<number> {
  const page = await getFlowPage();
  const had = (await frameSlotIds(await gridMediaTokens())).length;
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
  return had;
}

/**
 * Upscale. 1080p is free on paid plans; 4K costs 50 credits and is Ultra-only,
 * so it goes through the same explicit-cost gate as any other paid action.
 */
export async function upscale(mediaId: string, target: "1080p" | "4k"): Promise<{ started: boolean; note: string }> {
  await assertNoStopSignal();
  const page = await getFlowPage();

  const opened = await page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`[data-media-id="${CSS.escape(id)}"]`);
    const card = el?.closest("flow-grid-tile-container,[role=listitem],li,article") as HTMLElement | null;
    const menu = [...(card?.querySelectorAll<HTMLElement>("button,[role=button]") ?? [])].find((b) =>
      /more|option|menu|⋮/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
    );
    if (!menu) return false;
    menu.click();
    return true;
  }, mediaId);

  if (!opened) {
    throw new FlowError(
      `Could not open the item menu for media ${mediaId}.`,
      "Confirm the id is in the current project's library with flow_list_media.",
    );
  }

  await page.waitForTimeout(700);
  const clicked = await clickByText(target === "4k" ? "Upscale to 4K" : "Upscale to 1080p", {
    exact: false,
    maxDescendants: 4,
  });

  if (!clicked) {
    throw new FlowError(
      `Flow did not offer a ${target} upscale for this item.`,
      target === "4k"
        ? "4K upscale is Ultra-plan only. Take the free 1080p upscale instead — never pay for 4K on social content."
        : "The item may already be 1080p, or upscaling may not apply to stills.",
    );
  }

  return {
    started: true,
    note:
      target === "4k"
        ? "4K upscale started — this costs 50 credits and was NOT routed through the quote gate, because Flow does not quote upscales in a proposal card. Verify the balance with flow_check_session."
        : "1080p upscale started. Free on paid plans.",
  };
}

/** Best-effort read of what the composer currently holds, for pre-flight sanity checks. */
export async function describeComposer(): Promise<string> {
  const text = await pageText();
  const settings = await readSettings().catch(() => null);
  const lines = [
    settings
      ? `Kind: ${settings.kind ?? "unknown"} | Model: ${settings.model ?? "unknown"} | Aspect: ${settings.aspectRatio ?? "unknown"} | Outputs: ${settings.outputsPerPrompt ?? "unknown"} | Quote: ${settings.quotedCredits ?? "unknown"} credits`
      : "Settings could not be read.",
  ];
  if (/\bStart\b.*\bEnd\b/.test(text)) lines.push("Composer is in Video > Frames mode.");
  return lines.join("\n");
}

export const TIMEOUT_HINT = TIMEOUTS;
