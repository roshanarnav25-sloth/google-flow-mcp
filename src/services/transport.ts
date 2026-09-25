import { promises as fs } from "node:fs";
import { config, paths } from "../config.js";
import { TRPC_BASE, TIMEOUTS } from "../constants.js";
import { FlowError, type ApiMap, type Tier } from "../types.js";
import { assertNoStopSignal, cookieHeader, getFlowPage, reloadSession } from "./browser.js";

/**
 * THE TRANSPORT LADDER
 *
 * Google Flow ships no public API, but its frontend is a tRPC client — so an API
 * exists, it is just undocumented. We prefer it to clicking at every opportunity,
 * because procedure names are far more stable than minified class hashes.
 *
 *   Tier 1  http        Node fetch + the browser's cookies. No page involved.
 *                       Fastest, parallelisable. Only used for endpoints that
 *                       flow_discover_api has *confirmed* work this way.
 *   Tier 2  page-fetch  fetch() evaluated inside the authenticated tab. Auth and
 *                       CORS are free because the page's own origin makes the
 *                       call. This is the default and the workhorse.
 *   Tier 3  dom         Clicking. Reserved for surfaces with no endpoint at all
 *                       (settings gear, Scenebuilder timeline).
 *
 * Tier 2 also quietly fixes the biggest limitation in the old shell-based driver:
 * Playwright's evaluate awaits promises, so `fetch` works directly and the
 * synchronous-XHR hack the playbook needed is gone.
 */

let apiMapCache: ApiMap | null = null;

export async function loadApiMap(): Promise<ApiMap> {
  if (apiMapCache) return apiMapCache;
  try {
    apiMapCache = JSON.parse(await fs.readFile(paths.apiMap, "utf8")) as ApiMap;
  } catch {
    apiMapCache = { version: 1, discoveredAt: new Date().toISOString(), endpoints: {} };
  }
  return apiMapCache;
}

export async function saveApiMap(map: ApiMap): Promise<void> {
  apiMapCache = map;
  await fs.mkdir(config.stateDir, { recursive: true }).catch(() => {});
  await fs.writeFile(paths.apiMap, JSON.stringify(map, null, 2), "utf8");
}

export interface CallResult<T = unknown> {
  status: number;
  data: T;
  raw: string;
  tier: Tier;
  finalUrl: string;
}

/**
 * tRPC's HTTP contract: queries are GET with the input JSON-encoded in the query
 * string, mutations are POST with it in the body. Flow also exposes some
 * procedures with plain named query params (media.getMediaUrlRedirect?name=...),
 * so `rawQuery` bypasses the tRPC envelope when a discovered endpoint needs it.
 */
export interface TrpcCallOptions {
  procedure: string;
  method?: "GET" | "POST";
  input?: unknown;
  /** Use these query params verbatim instead of the tRPC `input=` envelope. */
  rawQuery?: Record<string, string>;
  /** Force a tier instead of taking the best available. */
  forceTier?: Tier;
  /** Retry once through a session reload on 401. */
  retryOnAuth?: boolean;
}

/** @internal exported for unit tests */
export function buildUrl(opts: TrpcCallOptions): string {
  const url = new URL(`${TRPC_BASE}/${opts.procedure}`);
  if (opts.rawQuery) {
    for (const [k, v] of Object.entries(opts.rawQuery)) url.searchParams.set(k, v);
  } else if ((opts.method ?? "GET") === "GET" && opts.input !== undefined) {
    url.searchParams.set("input", JSON.stringify({ json: opts.input }));
  }
  return url.toString();
}

function parseBody(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw);
    // tRPC wraps results as {result:{data:{json:...}}} when a transformer is set.
    const unwrapped = parsed?.result?.data?.json ?? parsed?.result?.data ?? parsed;
    return unwrapped;
  } catch {
    return raw;
  }
}

/** Tier 2 — the default. Runs inside the page, so the session is whatever the human has. */
async function callViaPage(opts: TrpcCallOptions): Promise<CallResult> {
  const page = await getFlowPage();
  const url = buildUrl(opts);
  const method = opts.method ?? "GET";
  const body = method === "POST" ? JSON.stringify({ json: opts.input ?? {} }) : null;

  const res = await page.evaluate(
    async ([u, m, b]) => {
      const r = await fetch(u as string, {
        method: m as string,
        credentials: "include",
        headers: { "content-type": "application/json", "x-trpc-source": "mcp" },
        ...(b ? { body: b as string } : {}),
      });
      return { status: r.status, text: await r.text(), finalUrl: r.url };
    },
    [url, method, body] as const,
  );

  return { status: res.status, data: parseBody(res.text), raw: res.text, tier: "page-fetch", finalUrl: res.finalUrl };
}

/** Tier 1 — no page in the loop. Only for endpoints discovery marked httpSafe. */
async function callViaHttp(opts: TrpcCallOptions): Promise<CallResult> {
  const url = buildUrl(opts);
  const method = opts.method ?? "GET";
  const res = await fetch(url, {
    method,
    headers: {
      cookie: await cookieHeader(),
      "content-type": "application/json",
      referer: TRPC_BASE,
    },
    ...(method === "POST" ? { body: JSON.stringify({ json: opts.input ?? {} }) } : {}),
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUTS.evalMs),
  });
  const raw = await res.text();
  return { status: res.status, data: parseBody(raw), raw, tier: "http", finalUrl: res.url };
}

/**
 * Call a Flow tRPC procedure, picking the cheapest tier that is known to work.
 *
 * A 401 here almost always means the tab's session went stale while idle rather
 * than a real logout, so we reload once and retry before reporting failure.
 */
export async function callTrpc<T = unknown>(opts: TrpcCallOptions): Promise<CallResult<T>> {
  const map = await loadApiMap();
  const known = map.endpoints[opts.procedure];
  const tier: Tier = opts.forceTier ?? (known?.httpSafe ? "http" : "page-fetch");

  let result = tier === "http" ? await callViaHttp(opts) : await callViaPage(opts);

  if (result.status === 401 && (opts.retryOnAuth ?? true)) {
    await reloadSession();
    result = tier === "http" ? await callViaHttp(opts) : await callViaPage(opts);
  }

  if (result.status === 401) {
    await assertNoStopSignal();
    throw new FlowError(
      `Flow returned 401 for ${opts.procedure} even after a session reload.`,
      "The browser is probably signed out. Sign into labs.google/fx/tools/flow in the attached Chrome window, then retry. This server never handles credentials.",
    );
  }

  if (result.status >= 400) {
    throw new FlowError(
      `Flow returned ${result.status} for ${opts.procedure}: ${result.raw.slice(0, 300)}`,
      result.status === 404
        ? `The procedure name may have changed. Run flow_discover_api to re-map Flow's endpoints.`
        : `Retry once; if it persists, run flow_check_session to confirm the tab is healthy.`,
    );
  }

  return result as CallResult<T>;
}

/**
 * Tier 3 helper. Flow's Approve/Reject controls are bare divs with no ARIA role,
 * so accessibility-tree selectors cannot see them and text matching is the only
 * option. `maxDescendants` is load-bearing: it is what keeps a match for
 * "Approve" from landing on the "Approve, do not ask again" row, which silently
 * disables the budget gate for the rest of the session.
 */
export async function clickByText(
  text: string,
  opts: { exact?: boolean; maxDescendants?: number } = {},
): Promise<boolean> {
  const page = await getFlowPage();
  return page.evaluate(
    ([target, exact, maxKids]) => {
      const nodes = [...document.querySelectorAll<HTMLElement>("button,div[role],div,span")];
      const match = nodes.filter((el) => {
        if (el.getClientRects().length === 0) return false; // offsetParent is null inside fixed overlays
        if (el.querySelectorAll("*").length > (maxKids as number)) return false;
        const t = (el.textContent ?? "").replace(/\s+/g, "");
        return exact
          ? t === (target as string).replace(/\s+/g, "")
          : t.includes((target as string).replace(/\s+/g, ""));
      });
      const el = match[match.length - 1];
      if (!el) return false;
      el.click();
      return true;
    },
    [text, opts.exact ?? true, opts.maxDescendants ?? 4] as const,
  );
}

/** Read the page's visible text, for quote parsing and stop-signal checks. */
export async function pageText(): Promise<string> {
  const page = await getFlowPage();
  return page.evaluate(() => document.body?.innerText ?? "");
}
