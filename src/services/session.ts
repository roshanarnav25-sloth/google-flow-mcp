import { config } from "../config.js";
import type { SessionState } from "../types.js";
import { assertNoStopSignal, browserMode, getFlowPage } from "./browser.js";
import { pageText } from "./transport.js";

/**
 * One call that answers "is it safe to spend credits right now". Every charged
 * tool runs this first, because each field maps to a way a run can go wrong:
 * signed out, no credits, wrong project, or — worst — the confirm gate switched
 * off, which lets Flow's agent generate and charge without ever showing a card.
 */
export async function readSession(): Promise<SessionState> {
  const state: SessionState = {
    browserConnected: false,
    browserMode: "none",
    loggedIn: false,
    account: null,
    credits: null,
    projectId: config.defaultProjectId,
    confirmGate: "unknown",
    blockedBy: null,
  };

  let page;
  try {
    page = await getFlowPage();
    state.browserConnected = true;
    state.browserMode = browserMode();
  } catch (err) {
    state.blockedBy = (err as Error).message;
    return state;
  }

  try {
    await assertNoStopSignal(page);
  } catch (err) {
    state.blockedBy = (err as Error).message;
  }

  // flow.google.com has no NextAuth endpoint. The One Google bar's account button
  // carries "Google Account: <name> (<email>)" only when a user is signed in.
  try {
    const label = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[aria-label^="Google Account:"]');
      return el?.getAttribute("aria-label") ?? null;
    });
    if (label) {
      state.account = /\(([^)]+@[^)]+)\)/.exec(label)?.[1] ?? label.replace(/^Google Account:\s*/, "");
      state.loggedIn = true;
    }
  } catch {
    // Fall through to the URL heuristic below.
  }

  if (!state.loggedIn) state.loggedIn = !/accounts\.google\.com|\/signin/.test(page.url());

  state.projectId = extractProjectId(page.url()) ?? state.projectId;
  state.credits = await readCredits();
  state.confirmGate = await readConfirmGate();

  return state;
}

export function extractProjectId(url: string): string | null {
  return /\/project\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null;
}

/** @internal exported for unit tests. Pulls a balance out of credit-shaped text. */
export function parseCredits(text: string): number | null {
  // Never a bare "N credits": the composer's "Generating will use N credits" quote
  // would read as a balance and defeat the affordability check.
  const patterns = [/([\d,]+)\s+Google\s+Flow\s+credits?\b/i, /([\d,]+)\s*credits?\s*(?:remaining|left|available)/i];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) {
      const n = Number.parseInt(m[1].replace(/,/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Credit balance. On flow.google.com it lives in the account panel behind the One
 * Google avatar ("50 Google Flow credits"), which is only in the DOM while open —
 * so open it, read it, close it. The panel also holds "Sign out of all accounts",
 * so it is closed by its exact aria-label, never by text. Falls back to scanning
 * the visible page. Returns null rather than guessing — callers treat an unknown
 * balance as "cannot verify budget" rather than "budget is fine".
 */
export async function readCredits(): Promise<number | null> {
  try {
    const page = await getFlowPage();
    // One in-page script, as verified live: a DOM click, not locator.click(). The
    // account button failed Playwright's actionability wait in the launched
    // profile and the balance silently read null, though the same button's label
    // is what proves sign-in.
    const text = await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const panel = () => document.querySelector<HTMLElement>("flow-account-panel");
      const alreadyOpen = panel() !== null;
      if (!alreadyOpen) {
        const trigger = [...document.querySelectorAll<HTMLElement>('[aria-label^="Google Account:"]')].find(
          (e) => e.getClientRects().length > 0,
        );
        if (!trigger) return null;
        trigger.click();
      }
      let count: Element | null = null;
      for (let i = 0; i < 40 && !count?.textContent?.trim(); i++) {
        await sleep(150);
        count = panel()?.querySelector(".credits-count") ?? null;
      }
      const read = count?.textContent?.trim() ?? null;
      if (!alreadyOpen) {
        panel()?.querySelector<HTMLElement>('button[aria-label="Close account panel"]')?.click();
      }
      return read;
    });
    const n = parseCredits(text ?? "");
    if (n !== null) return n;
  } catch {
    /* fall through to the page-text scan */
  }
  try {
    return parseCredits(await pageText());
  } catch {
    return null;
  }
}

/**
 * Flow's "Confirm before generating" setting. If a human ever clicked
 * "Approve, do not ask again", Flow stops showing approval cards and its agent
 * charges autonomously — including on its own silent retries after a failure.
 * Detecting that is the single highest-value safety check in this server.
 */
export async function readConfirmGate(): Promise<"always" | "off" | "unknown"> {
  try {
    const text = (await pageText()).replace(/\s+/g, " ");
    if (/confirm before generating[^.]{0,40}\boff\b/i.test(text)) return "off";
    if (/confirm before generating[^.]{0,40}\balways\b/i.test(text)) return "always";
  } catch {
    /* unknown */
  }
  return "unknown";
}

export function describeSession(s: SessionState): string {
  const lines = [
    `Browser: ${s.browserConnected ? `connected (${s.browserMode})` : "NOT CONNECTED"}`,
    `Signed in: ${s.loggedIn ? `yes${s.account ? ` (${s.account})` : ""}` : "NO"}`,
    `Credits: ${s.credits ?? "unknown"}`,
    `Project: ${s.projectId ?? "none selected"}`,
    `Confirm-before-generating: ${s.confirmGate}`,
  ];
  if (s.blockedBy) lines.push(`BLOCKED: ${s.blockedBy}`);
  if (s.confirmGate !== "always") {
    lines.push(
      `Note: "Confirm before generating" is not confirmed Always. On flow.google.com it only governs Agent mode; ` +
        `this server sends in direct mode behind the composer's price quote and refuses if Agent mode is on. ` +
        `If you use Agent mode by hand, set it to Always in the session panel's agent settings.`,
    );
  }
  return lines.join("\n");
}
