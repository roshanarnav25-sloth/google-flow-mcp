import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { config } from "../config.js";
import { FLOW_HOME, FLOW_ORIGIN, STOP_SIGNALS, TIMEOUTS, isFlowUrl } from "../constants.js";
import { FlowError, StopSignalError } from "../types.js";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let mode: "cdp-attach" | "launched" | "none" = "none";

/**
 * Attach to a Chrome the user already logged into, or launch a persistent one.
 *
 * CDP attach is the preferred path and the reason this server needs no credentials:
 * the human owns the login, we borrow the tab. `launchPersistentContext` is the
 * fallback for a headless box, and requires a one-time interactive login.
 */
let connecting: Promise<BrowserContext> | null = null;

export async function getContext(): Promise<BrowserContext> {
  if (context && isAlive()) return context;
  // MCP clients may call tools in parallel. Two concurrent launches on one persistent
  // profile race, and the loser fails with "profile is already in use" — so every
  // caller shares the one in-flight connect.
  connecting ??= connect().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function connect(): Promise<BrowserContext> {
  if (config.cdpUrl) {
    try {
      browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 10_000 });
    } catch (err) {
      throw new FlowError(
        `Could not attach to Chrome at ${config.cdpUrl}: ${(err as Error).message}`,
        `Start Chrome with remote debugging, then retry:\n` +
          `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.google-flow-mcp/chrome-profile"\n` +
          `Log into flow.google.com in that window first. ` +
          `Or unset FLOW_CDP_URL to let this server launch its own browser.`,
      );
    }
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    mode = "cdp-attach";
  } else {
    context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      channel: config.channel,
      viewport: { width: 1440, height: 900 },
      // No acceptDownloads: with it on, Chrome completes Flow's downloads and
      // crashes at completion (EXCEPTION_ACCESS_VIOLATION at chrome.dll+0x2f199a,
      // every time, 2026-09-24). Clip lookups want the download refused anyway;
      // scene exports route their one download through CDP (see scene.ts).
      args: ["--disable-blink-features=AutomationControlled"],
    });
    browser = null;
    mode = "launched";
    // A launched context has no Browser to ask isConnected(); without this, closing
    // the window leaves a dead handle that every later call trips over.
    const launched = context;
    launched.on("close", () => {
      if (context !== launched) return;
      context = null;
      page = null;
      mode = "none";
    });
  }

  context.setDefaultTimeout(TIMEOUTS.evalMs);
  return context;
}

function isAlive(): boolean {
  if (browser) return browser.isConnected();
  return context !== null;
}

export function browserMode(): "cdp-attach" | "launched" | "none" {
  return mode;
}

/**
 * The Flow tab. Reuses an existing one when present — opening a duplicate tab on
 * the same project is a known way to confuse Flow's chat state.
 */
export async function getFlowPage(): Promise<Page> {
  const ctx = await getContext();

  if (page && !page.isClosed() && isFlowUrl(page.url())) return page;

  const existing = ctx.pages().find((p) => !p.isClosed() && isFlowUrl(p.url()));
  if (existing) {
    page = existing;
    return page;
  }

  page = ctx.pages().find((p) => !p.isClosed()) ?? (await ctx.newPage());
  if (!isFlowUrl(page.url())) {
    await page.goto(FLOW_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  return page;
}

/**
 * Re-establish the page's API session. The playbook's key failure mode: after
 * hours idle the tRPC session 401s with "No session found", which curl cheerfully
 * writes over your .jpg. A reload restores it from the profile — no credentials.
 */
export async function reloadSession(): Promise<void> {
  const p = await getFlowPage();
  await p.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await p.waitForTimeout(3_000);
}

/**
 * Fail fast on walls a human must clear. Called before every charged action and
 * again after, so we never mistake a login screen for a generation failure.
 */
export async function assertNoStopSignal(p?: Page): Promise<void> {
  const target = p ?? (await getFlowPage());
  let text: string;
  try {
    text = await target.evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? "");
  } catch {
    return; // mid-navigation; the next check catches it
  }
  for (const { pattern, reason } of STOP_SIGNALS) {
    if (pattern.test(text)) throw new StopSignalError(reason);
  }
}

/** Cookies for the Flow origin, for the Node-side HTTP tier. */
export async function cookieHeader(): Promise<string> {
  const ctx = await getContext();
  const cookies = await ctx.cookies(FLOW_ORIGIN);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export async function closeBrowser(): Promise<void> {
  // Never close a browser we merely attached to — it is the user's window.
  if (mode === "launched" && context) await context.close().catch(() => {});
  if (mode === "cdp-attach" && browser) await browser.close().catch(() => {});
  browser = null;
  context = null;
  page = null;
  mode = "none";
}
