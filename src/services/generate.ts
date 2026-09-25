import { POLL_INTERVAL_MS, TIMEOUTS } from "../constants.js";
import { BudgetError, FlowError, type GenerationResult, type LedgerEntry } from "../types.js";
import { assertNoStopSignal, getFlowPage } from "./browser.js";
import {
  applySettings,
  attachFrames,
  attachMedia,
  clearAttachments,
  closeSettings,
  ensureDirectMode,
  readSettings,
} from "./compose.js";
import { appendLedger, assertAffordable, recordSpend } from "./ledger.js";
import { downloadMedia, listMedia } from "./media.js";
import { readCredits, readSession } from "./session.js";

/**
 * GENERATION IS THE ONLY PLACE THIS SERVER SPENDS MONEY.
 *
 * flow.google.com (September 2026 onward) runs the composer in DIRECT mode:
 * the prompt goes straight to the selected model and is charged on send. There
 * is no proposal card to reject. The price is instead stated up front in the
 * composer's settings popover ("Generating will use N credits"), so the gate is:
 *
 *   configure -> attach frames -> type prompt -> READ THE QUOTE -> check it
 *   -> only then press send
 *
 * Every refusal happens before send, while it is still free:
 *   - no readable quote            -> refuse
 *   - a "free" still quoting > 0   -> refuse
 *   - quote > expected_max_cost    -> refuse
 *   - quote would break the budget -> refuse
 * and an in-flight generation is never resubmitted: completion is detected by
 * diffing the media library, never by touching the composer again.
 */

export interface GenerateOptions {
  prompt: string;
  /** Refuse (before sending) if the composer quotes more than this. */
  expectedMaxCost: number;
  /** Read the price, clear the composer, charge nothing. */
  dryRun?: boolean;
  /** Send and return immediately. Collect later. */
  noWait?: boolean;
  /** Where to save. Relative paths resolve under FLOW_OUTPUT_DIR. */
  outFile?: string;
  /** A still. The composer must quote exactly 0 credits or the call refuses. */
  free?: boolean;
  timeoutMs?: number;
  startFrameMediaId?: string;
  endFrameMediaId?: string;
  referenceMediaIds?: string[];
}

export function describeMode(opts: GenerateOptions): string {
  if (opts.free) return "Image (still)";
  if (opts.referenceMediaIds?.length)
    return `Ingredients-to-Video (${opts.referenceMediaIds.length} reference image(s))`;
  if (opts.startFrameMediaId && opts.endFrameMediaId) return "Frames-to-Video (start + end frame)";
  if (opts.startFrameMediaId) return "Frames-to-Video (start frame)";
  return "Text-to-Video (no frame attached; composition is uncontrolled)";
}

/** Preflight that must pass before anything is typed into the composer. */
async function preflight(): Promise<number | null> {
  const session = await readSession();
  if (!session.browserConnected) {
    throw new FlowError("No browser session.", session.blockedBy ?? "Run flow_check_session for setup instructions.");
  }
  if (!session.loggedIn) {
    throw new FlowError(
      "The attached browser is not signed into Google Flow.",
      "Sign in at flow.google.com in that Chrome window. This server never handles credentials.",
    );
  }
  if (session.blockedBy) throw new FlowError(session.blockedBy);
  if (!session.projectId) {
    throw new FlowError("No Flow project is open.", "Open one with flow_open_project first. Nothing was charged.");
  }
  return session.credits;
}

function composerHandle() {
  return `.ProseMirror[contenteditable="true"]`;
}

/**
 * Type the prompt into the composer WITHOUT sending it. The composer is a
 * ProseMirror contenteditable, so real keyboard input into the focused editor is
 * the reliable route.
 */
async function typePrompt(prompt: string): Promise<void> {
  const page = await getFlowPage();
  const editor = page.locator(composerHandle()).last();
  if ((await editor.count()) === 0) {
    throw new FlowError(
      "Could not find Flow's prompt box.",
      "Confirm a Flow project is open (flow.google.com/project/<id>) and run flow_check_session. Nothing was charged.",
    );
  }
  await editor.click();
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Delete").catch(() => {});
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(400);
  const typed = (await editor.innerText()).trim();
  if (typed.length < Math.min(prompt.trim().length, 20)) {
    throw new FlowError("The prompt did not land in Flow's prompt box.", "Nothing was sent or charged. Retry once.");
  }
}

async function promptStillTyped(prompt: string): Promise<boolean> {
  const page = await getFlowPage();
  const typed = await page
    .locator(composerHandle())
    .last()
    .innerText()
    .catch(() => "");
  return typed.trim().length >= Math.min(prompt.trim().length, 20);
}

async function progressTileCount(): Promise<number> {
  const page = await getFlowPage();
  return page.evaluate(() => (document.body.innerText.match(/^\s*\d{1,3}%\s*$/gm) ?? []).length);
}

/** Press send once, and confirm Flow accepted it. Never presses twice. */
async function send(): Promise<void> {
  const page = await getFlowPage();
  // An open settings popover swallows the send click (observed 2026-09-24).
  await closeSettings();
  const progressBefore = await progressTileCount();
  // A real pointer click (Playwright input at the button's position), not a DOM
  // btn.click(): observed 2026-09-24, every send Flow accepted was a real mouse
  // click, while scripted DOM clicks on the same button were ignored. Playwright
  // checks the button is visible, enabled and not covered before it clicks, and
  // throws without clicking otherwise, so this can never press twice.
  const button = page.locator('button[aria-label="Start generation"]:visible:enabled').first();
  const clicked =
    (await button.count()) > 0 &&
    (await button
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false));
  if (!clicked) {
    const state = await page
      .evaluate(() => {
        const ed = document.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
        let scope: HTMLElement | null = ed;
        for (let k = 0; k < 8 && scope?.parentElement; k++) scope = scope.parentElement;
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Start generation"]')]
          .map((b) => `${b.offsetParent ? "visible" : "hidden"}/${b.disabled ? "disabled" : "enabled"}`)
          .join(", ");
        const overlays = [...document.querySelectorAll<HTMLElement>(".cdk-overlay-pane")]
          .filter((p) => p.getClientRects().length > 0)
          .map((p) => p.innerText.replace(/\s+/g, " ").trim().slice(0, 60));
        return `prompt ${ed?.innerText.trim().length ?? "missing"} chars; send buttons [${buttons || "none"}]; open overlays [${overlays.join(" | ")}]; composer ends "${(scope?.innerText ?? "").replace(/\s+/g, " ").trim().slice(-80)}"`;
      })
      .catch(() => "unreadable");
    throw new FlowError(
      `Could not find an enabled Start generation button (${state}).`,
      "Nothing was sent or charged.",
    );
  }

  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(800);
    // Flow reports a refused submission in a toast, and may clear the prompt box as
    // it does so — which would otherwise read as "accepted" below.
    const refused = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("mat-snack-bar-container,[role=alert],[aria-live=assertive]")]
        .map((e) => e.innerText.replace(/\s+/g, " ").trim())
        .find((t) => /couldn.?t|could not|failed|error|unable|try again|policy|violat|not allowed/i.test(t)),
    );
    if (refused) {
      throw new FlowError(
        `Flow refused the generation: "${refused.slice(0, 200)}"`,
        "Flow reported this before starting anything; check the balance with flow_check_session. Do not resubmit unchanged.",
      );
    }
    // A confirmation dialog we do not know about: stop without clicking anything.
    const dialog = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[role=dialog],[role=alertdialog]")]
        .map((d) => d.innerText)
        .find((t) => /credit|confirm|generate/i.test(t) && !/Select a frame image/i.test(t)),
    );
    if (dialog) {
      throw new FlowError(
        `Flow showed an unexpected dialog after send: "${dialog.replace(/\s+/g, " ").slice(0, 200)}"`,
        "Nothing was clicked in it. Resolve it in the browser; if it asks to confirm a charge, that is a new cost gate this server must learn.",
      );
    }
    const text = await page
      .locator(composerHandle())
      .last()
      .innerText()
      .catch(() => "");
    if (text.trim().length === 0 || (await progressTileCount()) > progressBefore) return;
  }
  throw new FlowError(
    "Send was pressed but Flow shows no sign of accepting it (prompt still in the box, no progress tile).",
    "It MAY still have been accepted. Check the project grid in the browser before retrying — do NOT resubmit blindly.",
  );
}

/**
 * Poll for media that did not exist before submission, and keep polling briefly
 * after the first arrives so every output of an x2/x3/x4 batch is collected.
 */
async function awaitNewMedia(before: Set<string>, timeoutMs: number, expected = 1): Promise<string[]> {
  let deadline = Date.now() + timeoutMs;
  // Observed 2026-09-24: a charged clip finished after the 480s window while the
  // server's grid showed nothing, so the run "timed out" on a success. While a
  // tile is visibly rendering (NN%), extend the wait, up to this much extra.
  const extendUntil = deadline + 10 * 60_000;
  const page = await getFlowPage();
  let fresh: string[] = [];
  let settleUntil = 0;
  let lastReload = Date.now();

  for (;;) {
    if (Date.now() >= deadline) {
      const rendering = await page
        .evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("flow-grid-tile-container")].some((t) =>
            /\b\d{1,3}%/.test(t.innerText),
          ),
        )
        .catch(() => false);
      if (!rendering || fresh.length > 0 || Date.now() >= extendUntil) break;
      deadline = Math.min(Date.now() + 60_000, extendUntil);
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);
    // The grid may not live-update in the server's browser. After send the
    // composer no longer matters, so a periodic reload is free and safe.
    if (fresh.length === 0 && Date.now() - lastReload > 90_000) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
      await page.waitForSelector("flow-grid-tile-container", { timeout: 15_000 }).catch(() => undefined);
      lastReload = Date.now();
    }
    await assertNoStopSignal(page);
    const { items } = await listMedia(500, 0);
    const now = items.map((i) => i.mediaId).filter((id) => !before.has(id));
    if (now.length > fresh.length) {
      fresh = now;
      settleUntil = Date.now() + 20_000;
    }
    if (fresh.length >= expected) return fresh;
    if (fresh.length > 0 && Date.now() > settleUntil) return fresh;
  }

  if (fresh.length > 0) return fresh;
  throw new FlowError(
    `The generation was sent but produced no new media within ${Math.round(timeoutMs / 1000)}s (plus any extension while a tile was rendering).`,
    "It was CHARGED and may still be rendering. Check the project grid and use flow_collect or flow_download once it appears. Do NOT resubmit — that is a second charge.",
  );
}

export async function generate(opts: GenerateOptions): Promise<GenerationResult> {
  const notes: string[] = [];
  const balanceBefore = await preflight();
  await assertNoStopSignal();

  // Snapshot the library FIRST. Listing can reload the page (to capture the
  // grid's media-list RPC) or open clip editors (fallback lookup); either wipes
  // the composer. Taken after typing, it emptied the prompt before send — live,
  // a still refused with "prompt 0 chars", and a Frames video went out blank.
  const { items: beforeItems } = await listMedia(500, 0);
  const before = new Set(beforeItems.map((i) => i.mediaId));

  // Reset the composer so no stale prompt or frame chip leaks into this call.
  await clearAttachments();
  await ensureDirectMode();

  if (opts.referenceMediaIds?.length) await attachMedia(opts.referenceMediaIds);
  await applySettings(opts.free ? { kind: "image" } : { kind: "video", videoMode: "frames" });
  if (!opts.free && (opts.startFrameMediaId || opts.endFrameMediaId)) {
    const { missing } = await attachFrames(opts.startFrameMediaId, opts.endFrameMediaId);
    if (missing.length > 0) {
      await clearAttachments();
      throw new FlowError(
        `Could not find ${missing.join(", ")} in the frame picker.`,
        "Nothing was charged. Confirm the ids with flow_list_media; uploaded frames must finish uploading first.",
      );
    }
  }
  notes.push(`Mode: ${describeMode(opts)}.`);

  await typePrompt(opts.prompt);

  // THE GATE: read the composer's own price for exactly what is about to be sent.
  const settings = await readSettings();
  const quote = settings.quotedCredits;
  notes.push(
    `Composer: ${settings.kind ?? "?"} · ${settings.model ?? "?"} · ${settings.resolution ?? ""} ${settings.durationSeconds ? settings.durationSeconds + "s" : ""} · x${settings.outputsPerPrompt ?? "?"} · quoted ${quote ?? "?"} credits.`,
  );

  const refuse = async (err: Error, verdict: LedgerEntry["verdict"], note?: string) => {
    await clearAttachments().catch(() => 0);
    await log({
      kind: opts.free ? "still" : "video",
      opts,
      quoted: quote ?? 0,
      charged: 0,
      balance: balanceBefore,
      verdict,
      files: [],
      note,
    });
    throw err;
  };

  if (quote === null) {
    await refuse(
      new FlowError(
        "Could not read the composer's price quote.",
        "Nothing was sent or charged. Flow's UI may have changed.",
      ),
      "rejected",
      "no quote",
    );
  }
  // ensureDirectMode() clicks the toggle but cannot see whether it took. In Agent
  // mode Flow's agent may charge on its own if "Confirm before generating" is Never,
  // bypassing the quote above — so anything but a confirmed direct mode refuses.
  if (settings.agentMode !== false) {
    await refuse(
      new FlowError(
        settings.agentMode ? "The composer is still in Agent mode." : "Could not read the composer's Agent toggle.",
        "Nothing was sent or charged. Turn Agent mode off in the composer and retry.",
      ),
      "rejected",
      "not in direct mode",
    );
  }
  if (opts.free && quote !== 0) {
    await refuse(
      new BudgetError(
        `This still would cost ${quote} credits, not 0.`,
        "Nothing was sent. Switch the image model to a free tier with flow_settings, or generate it as a paid call.",
      ),
      "rejected",
      "still not free",
    );
  }
  if (!opts.free) {
    try {
      await assertAffordable(quote as number, opts.expectedMaxCost, balanceBefore);
    } catch (err) {
      await refuse(err as Error, "rejected");
    }
  }

  if (opts.dryRun) {
    await clearAttachments();
    await log({
      kind: "video",
      opts,
      quoted: quote as number,
      charged: 0,
      balance: balanceBefore,
      verdict: "rejected",
      files: [],
      note: "dry run",
    });
    return {
      verdict: "rejected",
      quotedCost: quote as number,
      charged: 0,
      mediaIds: [],
      files: [],
      balanceAfter: balanceBefore,
      tier: "dom",
      notes: [...notes, `Dry run: the composer quoted ${quote} credits. Nothing was sent.`],
    };
  }

  // Last check before the one irreversible click: the prompt must still be in
  // the box. The quote read above depends on settings, not on the prompt text,
  // so re-typing does not invalidate it.
  if (!(await promptStillTyped(opts.prompt))) {
    await typePrompt(opts.prompt);
    if (!(await promptStillTyped(opts.prompt))) {
      await refuse(
        new FlowError(
          "The prompt box was emptied before send and could not be refilled.",
          "Nothing was sent or charged.",
        ),
        "rejected",
        "prompt lost before send",
      );
    }
    notes.push("The prompt box had been emptied before send; re-typed and verified.");
  }

  await send();
  const charged = quote as number;
  if (charged > 0) await recordSpend(charged);
  notes.push(`Sent at ${charged} credits.`);

  if (opts.noWait) {
    await log({
      kind: opts.free ? "still" : "video",
      opts,
      quoted: charged,
      charged,
      balance: balanceBefore,
      verdict: "in_flight",
      files: [],
    });
    return {
      verdict: "in_flight",
      quotedCost: charged,
      charged,
      mediaIds: [],
      files: [],
      balanceAfter: null,
      tier: "dom",
      notes: [
        ...notes,
        `Returned without waiting. Known media before send: ${[...before].join(",") || "none"}. Use flow_collect.`,
      ],
    };
  }

  const expected = settings.outputsPerPrompt ?? 1;
  let mediaIds: string[];
  try {
    mediaIds = await awaitNewMedia(
      before,
      opts.timeoutMs ?? (opts.free ? TIMEOUTS.stillMs : TIMEOUTS.renderMs),
      expected,
    );
  } catch (err) {
    await settleTimeout(err as Error, { opts, charged, balanceBefore });
    throw err;
  }
  const files = await saveAll(mediaIds, opts.outFile, opts.free ? "jpg" : "mp4");
  const balanceAfter = await readCredits();

  await log({
    kind: opts.free ? "still" : "video",
    opts,
    quoted: charged,
    charged,
    balance: balanceAfter,
    verdict: "downloaded",
    files,
  });

  return { verdict: "downloaded", quotedCost: charged, charged, mediaIds, files, balanceAfter, tier: "dom", notes };
}

/**
 * A send that produced no media within the timeout. It is ALWAYS recorded as
 * charged and possibly still rendering — never refunded.
 *
 * An unchanged balance is NOT evidence that nothing started: Flow debits when a
 * clip finishes, not when it is sent. Seen live 2026-09-24: a Frames send timed
 * out at 480s with the balance unchanged and no progress tile in the server's
 * grid, then finished later as a new clip and the balance dropped by 4. A
 * refund there would have let the budget undercount real spend. The balance is
 * recorded so a later flow_check_session can reconcile.
 */
async function settleTimeout(
  err: Error,
  ctx: { opts: GenerateOptions; charged: number; balanceBefore: number | null },
): Promise<void> {
  try {
    const balanceAfter = await readCredits();
    if (ctx.balanceBefore !== null && balanceAfter === ctx.balanceBefore) {
      err.message += ` The balance is still ${balanceAfter}; Flow debits on completion, so this can still finish and charge. Check the grid later with flow_list_media or flow_collect.`;
    }
    await log({
      kind: ctx.opts.free ? "still" : "video",
      opts: ctx.opts,
      quoted: ctx.charged,
      charged: ctx.charged,
      balance: balanceAfter,
      verdict: "in_flight",
      files: [],
      note: "timed out waiting for media; counted as charged",
    });
  } catch {
    /* the original timeout error is what the caller needs */
  }
}

async function saveAll(mediaIds: string[], outFile: string | undefined, ext: string): Promise<string[]> {
  const files: string[] = [];
  for (const [i, id] of mediaIds.entries()) {
    const name = outFile
      ? mediaIds.length > 1
        ? outFile.replace(/(\.[^.]+)?$/, `-${i + 1}$1`)
        : outFile
      : `flow-${Date.now()}-${i + 1}.${ext}`;
    const saved = await downloadMedia(id, name);
    files.push(saved.file);
  }
  return files;
}

async function log(args: {
  kind: LedgerEntry["kind"];
  opts: GenerateOptions;
  quoted: number;
  charged: number;
  balance: number | null;
  verdict: LedgerEntry["verdict"];
  files: string[];
  note?: string;
}): Promise<void> {
  await appendLedger({
    ts: new Date().toISOString(),
    kind: args.kind,
    prompt: args.opts.prompt.slice(0, 500),
    model: null,
    quotedCost: args.quoted,
    charged: args.charged,
    balanceAfter: args.balance,
    verdict: args.verdict,
    files: args.files,
    note: args.note ?? null,
  });
}

/** Download everything that appeared since a known set of ids — the no_wait collector. */
export async function collect(knownIds: string[], outDir?: string): Promise<{ mediaIds: string[]; files: string[] }> {
  const before = new Set(knownIds);
  const mediaIds = await awaitNewMedia(before, TIMEOUTS.renderMs);
  const files: string[] = [];
  const items = (await listMedia(500, 0)).items;
  for (const id of mediaIds) {
    const kind = items.find((i) => i.mediaId === id)?.kind ?? "video";
    const saved = await downloadMedia(
      id,
      `${outDir ? outDir + "/" : ""}flow-${id.slice(-12)}.${kind === "image" ? "jpg" : "mp4"}`,
    );
    files.push(saved.file);
  }
  return { mediaIds, files };
}
