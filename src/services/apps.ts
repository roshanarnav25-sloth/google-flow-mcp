import { projectUrl } from "../constants.js";
import { FlowError } from "../types.js";
import { assertNoStopSignal, getFlowPage } from "./browser.js";
import { extractProjectId } from "./session.js";
import { pageText } from "./transport.js";

/**
 * FLOW TOOLS MARKETPLACE ("apps")
 *
 * Flow ships a gallery of first-party and community mini-apps at
 * /project/<id>/tools — Type Overlays, Transition Machine, Stringout Creator,
 * Video Resizer, Shader Effects, Poster Designer, Image Editor, Mask Magic,
 * Storyboard Studio, Style Writer, Prompt Tree, plus anything a user has built.
 *
 * THE HAZARD: the gallery quotes NO costs. A tool that internally calls Veo can
 * charge, and nothing in the listing tells you which ones do. That breaks the
 * assumption the rest of this server rests on — that Flow always quotes before
 * charging — so tool execution is deliberately the most locked-down surface here:
 *
 *   - listing is free and unrestricted
 *   - running requires an explicit acknowledgement that cost is UNKNOWN
 *   - the credit balance is captured before and after, so actual spend is
 *     measured rather than assumed
 *
 * Prefer a local ffmpeg/editor for anything a Flow app would do to finished
 * footage. These apps are worth it for capabilities you cannot reproduce
 * (segmentation edits, style transfer), not for concatenation or resizing.
 */

export interface FlowApp {
  name: string;
  description: string | null;
  url: string | null;
  source: "discover" | "my-tools" | "unknown";
}

export async function listApps(): Promise<FlowApp[]> {
  const page = await getFlowPage();
  await assertNoStopSignal(page);

  const projectId = extractProjectId(page.url());
  if (!projectId) {
    throw new FlowError(
      "No Flow project is open, so the Tools gallery cannot be reached.",
      "Open a project with flow_open_project first — the gallery lives at /project/<id>/tools.",
    );
  }

  if (!/\/tools/.test(page.url())) {
    await page.goto(`${projectUrl(projectId)}/tools`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);
  }

  return page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>("[role=listitem],article,a[href*='tool']")];
    const seen = new Map<string, { name: string; description: string | null; url: string | null; source: string }>();
    for (const card of cards) {
      if (!card.offsetParent) continue;
      const heading = card.querySelector("h1,h2,h3,h4,[class*='title']");
      const name = (heading?.textContent ?? card.getAttribute("aria-label") ?? "").trim();
      if (!name || name.length > 80 || seen.has(name)) continue;
      const para = card.querySelector("p");
      const link = card.matches("a") ? (card as HTMLAnchorElement).href : (card.querySelector("a")?.href ?? null);
      seen.set(name, {
        name,
        description: (para?.textContent ?? "").trim() || null,
        url: link,
        source: /my tools/i.test(document.body.innerText.slice(0, 2000)) ? "my-tools" : "discover",
      });
    }
    return [...seen.values()];
  }) as Promise<FlowApp[]>;
}

export interface RunAppResult {
  app: string;
  opened: boolean;
  balanceBefore: number | null;
  balanceAfter: number | null;
  measuredSpend: number | null;
  note: string;
}

/**
 * Open a Flow app and hand control back. This deliberately does NOT drive the
 * app's own form: each app has a bespoke UI, and blind-clicking through an
 * unknown form that may call Veo is exactly how an unbounded charge happens.
 */
export async function openApp(appName: string, acknowledgeUnknownCost: boolean): Promise<RunAppResult> {
  if (!acknowledgeUnknownCost) {
    throw new FlowError(
      `Refusing to open the Flow app "${appName}" without an explicit acknowledgement that its cost is unknown.`,
      "Flow's Tools gallery quotes no prices, and some apps call Veo internally. Re-call with acknowledge_unknown_cost=true only if whoever owns the credits accepts an unquoted charge.",
    );
  }

  const { readCredits } = await import("./session.js");
  const balanceBefore = await readCredits();

  const apps = await listApps();
  const match =
    apps.find((a) => a.name.toLowerCase() === appName.toLowerCase()) ??
    apps.find((a) => a.name.toLowerCase().includes(appName.toLowerCase()));

  if (!match) {
    throw new FlowError(
      `No Flow app named "${appName}" was found in this project's Tools gallery.`,
      `Available: ${
        apps
          .map((a) => a.name)
          .slice(0, 20)
          .join(", ") || "(none detected)"
      }`,
    );
  }

  const page = await getFlowPage();
  if (match.url) {
    await page.goto(match.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else {
    await page.evaluate((name) => {
      const card = [...document.querySelectorAll<HTMLElement>("[role=listitem],article,a")].find((c) =>
        (c.textContent ?? "").includes(name),
      );
      card?.click();
    }, match.name);
  }
  await page.waitForTimeout(4_000);
  await assertNoStopSignal(page);

  const balanceAfter = await readCredits();

  return {
    app: match.name,
    opened: true,
    balanceBefore,
    balanceAfter,
    measuredSpend: balanceBefore !== null && balanceAfter !== null ? balanceBefore - balanceAfter : null,
    note:
      "The app is open in the browser. This server does not drive app forms — each has a bespoke UI and may call Veo without quoting. " +
      "Drive it manually, or re-check the balance with flow_check_session after it runs to measure what it actually cost.",
  };
}

/** What the gallery says about an app, without running it. Free. */
export async function describeApp(appName: string): Promise<string> {
  const apps = await listApps();
  const match = apps.find((a) => a.name.toLowerCase().includes(appName.toLowerCase()));
  if (!match) return `No app matching "${appName}". Run flow_list_apps to see what this project offers.`;
  const context = await pageText();
  const priced = /credit/i.test(context)
    ? "Page mentions credits — read it before running."
    : "No price shown, as usual for this gallery.";
  return `${match.name}\n${match.description ?? "(no description)"}\nURL: ${match.url ?? "n/a"}\nCost: UNKNOWN. ${priced}`;
}
