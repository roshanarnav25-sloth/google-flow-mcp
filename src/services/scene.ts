import { promises as fs } from "node:fs";
import * as path from "node:path";
import { config } from "../config.js";
import { KNOWN_PROCEDURES, MIN_MEDIA_BYTES, TIMEOUTS, projectUrl } from "../constants.js";
import { FlowError } from "../types.js";
import { assertNoStopSignal, getFlowPage } from "./browser.js";
import { openVideoEditor } from "./media.js";
import { clickByText } from "./transport.js";

/**
 * SCENEBUILDER EXPORT
 *
 * Stitching clips in Scenebuilder is free — there is no approval card, because
 * nothing is generated. Only "Extend" costs credits, and this module never
 * touches it.
 *
 * The hard part is retrieval. Flow's export runs a `runVideoFxConcatenation`
 * job and returns the finished MP4 as base64 inside the poll response; Chromium
 * never writes a file. The previous shell-based driver had to monkey-patch
 * window.fetch to intercept it. Playwright can simply read the response body off
 * the wire, which is both simpler and immune to the app changing its fetch usage.
 */

/**
 * Export a scene (flow.google.com: /project/<p>/scene/<id>).
 *
 * Observed 2026-09-24: a scene is its own media item. Adding a clip in a clip's
 * editor (/edit/<id>) creates "Untitled Scene <date>" at /scene/<id>, whose top
 * bar has a plain "Download scene" button. A clip editor's "Download media"
 * menu downloads ONLY that clip — live, a two-clip "export" from there came back
 * byte-identical to clip 1 — so a clip editor is refused here, not exported.
 *
 * The file is taken from a browser download (Playwright's `download` event), or
 * the legacy base64 concat payload. There is deliberately NO flow-content CDN
 * channel: the scene's player loads individual clip files from there, and one of
 * those is exactly the wrong file. Every result must be a real MP4 before
 * anything is written.
 */
export async function exportScene(
  outFile: string,
  timeoutMs = TIMEOUTS.exportMs,
  sceneId?: string,
): Promise<{ file: string; bytes: number; via: "download" | "legacy"; sceneId: string }> {
  const page = await getFlowPage();
  await assertNoStopSignal(page);

  if (sceneId) {
    const project = /\/project\/([A-Za-z0-9_-]+)/.exec(page.url())?.[1];
    if (!project) {
      throw new FlowError("No Flow project is open.", "Open one with flow_open_project first. Nothing was charged.");
    }
    await page.goto(`${projectUrl(project)}/scene/${sceneId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_000);
  }

  if (/\/edit\//.test(page.url())) {
    throw new FlowError(
      "This is a single clip's editor, not a scene: its download is that one clip.",
      "Add clips with flow_add_clips_to_scene, which moves to the new scene (/scene/<id>), or pass that scene_id here. Nothing was charged.",
    );
  }
  const currentScene = /\/scene\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (!currentScene) {
    throw new FlowError(
      "The browser is not on a scene.",
      "Pass scene_id (from flow_add_clips_to_scene), or open the scene in the browser. Nothing was charged.",
    );
  }

  // Arm before clicking, or a fast export finishes unobserved.
  const download = page.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
  const legacy = page
    .waitForResponse(
      (res) =>
        new RegExp(`${KNOWN_PROCEDURES.concatenateStatus}|${KNOWN_PROCEDURES.concatenate}`, "i").test(res.url()) &&
        res.status() < 400,
      { timeout: timeoutMs },
    )
    .catch(() => null);

  // Flow stitches the scene in the page and downloads it from a blob: url via a
  // short-lived page, which is gone before Playwright can save it ("Target page,
  // context or browser has been closed"). Keep a reference to any video-sized
  // Blob the page turns into an object url, so its bytes can be read directly.
  await page.evaluate(() => {
    const w = window as unknown as { __flowBlobs?: Blob[]; __flowBlobHook?: boolean };
    w.__flowBlobs = [];
    if (w.__flowBlobHook) return;
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      if (obj instanceof Blob && (obj.type.startsWith("video/") || obj.size > 50_000)) w.__flowBlobs?.push(obj);
      return original(obj);
    };
    // The blob may be minted in a worker (live, the hook above saw nothing), and
    // is usually revoked right after the download link is clicked. Fetch it at
    // the click, synchronously kicked off, so it is read before revocation.
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.href.startsWith("blob:")) {
        fetch(this.href)
          .then((r) => r.blob())
          .then((b) => w.__flowBlobs?.push(b))
          .catch(() => undefined);
      }
      return click.call(this);
    };
    w.__flowBlobHook = true;
  });

  // Most reliable of all: have Chrome itself write the download into a
  // server-owned folder, however the page produced it (worker blob, short-lived
  // page). Chrome names the file by download guid and reports completion.
  const dlDir = path.join(config.stateDir, "downloads");
  await fs.rm(dlDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(dlDir, { recursive: true });
  let completedGuid: string | null = null;
  const cdp = await page
    .context()
    .newCDPSession(page)
    .catch(() => null);
  if (cdp) {
    cdp.on("Browser.downloadProgress", (e: { guid: string; state: string }) => {
      if (e.state === "completed") completedGuid = e.guid;
    });
    await cdp
      .send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir, eventsEnabled: true })
      .catch(() => undefined);
  }

  await clickDownloadScene();

  const target = path.isAbsolute(outFile) ? outFile : path.join(config.outputDir, outFile);
  await fs.mkdir(path.dirname(target), { recursive: true });

  const d = await download;
  // Wait for Chrome to finish writing it. Node timers, not page.waitForTimeout:
  // live, the server's Chrome exited partway through a scene download (every
  // page call then throws "Target page, context or browser has been closed"),
  // yet the .crdownload on disk was already the complete, decodable scene.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const onDisk = await (async () => {
    let lastSize = -1;
    let stableFor = 0;
    for (let i = 0; i < 240; i++) {
      const names = await fs.readdir(dlDir).catch(() => [] as string[]);
      // "allow" saves under the suggested name; "allowAndName" under the guid.
      const finished = names.find((n) => !n.endsWith(".crdownload") && (n === completedGuid || /\.mp4$/i.test(n)));
      if (finished) {
        const done = await fs.readFile(path.join(dlDir, finished)).catch(() => null);
        if (done && isCompleteMp4(done)) return done;
      }
      const partial = names.find((n) => n.endsWith(".crdownload"));
      if (partial) {
        const size = (await fs.stat(path.join(dlDir, partial)).catch(() => null))?.size ?? -1;
        stableFor = size > 0 && size === lastSize ? stableFor + 1 : 0;
        lastSize = size;
        // Unchanged for 3s and structurally complete: take it even if Chrome
        // never renamed it.
        if (stableFor >= 6) {
          const bytes = await fs.readFile(path.join(dlDir, partial)).catch(() => null);
          if (bytes && isCompleteMp4(bytes)) return bytes;
        }
      }
      await sleep(500);
    }
    return null;
  })();
  if (onDisk && onDisk.length >= MIN_MEDIA_BYTES && isCompleteMp4(onDisk)) {
    await fs.writeFile(target, onDisk);
    await fs.rm(dlDir, { recursive: true, force: true }).catch(() => undefined);
    return { file: target, bytes: onDisk.length, via: "download", sceneId: currentScene };
  }
  let buffer: Buffer | null = null;
  let via: "download" | "legacy" = "legacy";
  let detail = "";
  if (d) {
    via = "download";
    // saveAs works for blob: downloads (scene exports are built in the page);
    // a path is only kept when the context accepts downloads.
    let saveError = "";
    const staged = `${target}.part`;
    try {
      await d.saveAs(staged);
      buffer = await fs.readFile(staged);
    } catch (err) {
      saveError = (err as Error).message.split(/\r?\n/)[0];
    } finally {
      await fs.rm(staged, { force: true }).catch(() => undefined);
    }
    if (!buffer) {
      // Playwright had no file for it (failed, or cancelled). An http(s) url can
      // still be fetched directly; a blob: url cannot leave the page.
      const u = d.url();
      if (/^https?:\/\//.test(u)) {
        buffer = Buffer.from(await (await fetch(u, { redirect: "follow" })).arrayBuffer());
      } else {
        const b64 = await page
          .evaluate(async (blobUrl) => {
            const w = window as unknown as { __flowBlobs?: Blob[] };
            // The click hook's fetch may still be in flight; give it a moment.
            for (let i = 0; i < 20 && !(w.__flowBlobs ?? []).length; i++) await new Promise((r) => setTimeout(r, 250));
            let blob = [...(w.__flowBlobs ?? [])].sort((a, b) => b.size - a.size)[0];
            if (!blob && blobUrl.startsWith("blob:")) {
              blob = await fetch(blobUrl)
                .then((r) => r.blob())
                .catch(() => undefined as unknown as Blob);
            }
            if (!blob) return "";
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let s = "";
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(s);
          }, u)
          .catch(() => "");
        if (b64) buffer = Buffer.from(b64, "base64");
      }
      const shape = (() => {
        try {
          const p = new URL(u);
          return p.protocol === "blob:" ? "blob:" : `${p.host}${p.pathname.slice(0, 60)}`;
        } catch {
          return "unparsable";
        }
      })();
      detail = ` Download: file "${d.suggestedFilename()}", url ${shape}, failure ${(await d.failure().catch(() => null)) ?? "none"}${saveError ? `, save error: ${saveError}` : ""}.`;
    }
  } else {
    buffer = Buffer.from(await pollForEncodedVideo(legacy, timeoutMs), "base64");
  }

  if (!buffer || buffer.length < MIN_MEDIA_BYTES || buffer.subarray(4, 8).toString() !== "ftyp") {
    throw new FlowError(
      `Scene export (via ${via}) returned ${buffer?.length ?? 0} bytes that are not a valid MP4.${detail}`,
      "Nothing was written. The export may still be running — wait and retry, or download the scene in the browser.",
    );
  }
  await fs.writeFile(target, buffer);
  return { file: target, bytes: buffer.length, via, sceneId: currentScene };
}

/**
 * Walk the MP4's top-level boxes: `ftyp` first, a `moov` present, and the last
 * box ending exactly at the end of the buffer. A download cut off mid-write
 * fails the last check, so an unrenamed .crdownload is only trusted when whole.
 * @internal exported for unit tests
 */
export function isCompleteMp4(buf: Buffer): boolean {
  let offset = 0;
  let sawMoov = false;
  let first = true;
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    if (first && type !== "ftyp") return false;
    first = false;
    if (size === 1) {
      if (offset + 16 > buf.length) return false;
      const big = buf.readBigUInt64BE(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(big);
    } else if (size === 0) {
      size = buf.length - offset; // box runs to end of file
    }
    if (size < 8 || offset + size > buf.length) return false;
    if (type === "moov") sawMoov = true;
    offset += size;
  }
  return sawMoov && offset === buf.length;
}

/**
 * Click the scene's "Download scene". Observed as a plain button; if a later
 * release turns it into a menu, pick "Original size". A dialog that mentions
 * credits stops the export without clicking anything in it.
 */
async function clickDownloadScene(): Promise<void> {
  const page = await getFlowPage();
  const clicked = await page.evaluate(() => {
    document.querySelector<HTMLElement>(".cdk-overlay-backdrop")?.click(); // leftover picker/popover
    const visible = [...document.querySelectorAll<HTMLElement>("button")].filter(
      (b) => b.getClientRects().length > 0 && !b.closest(".cdk-overlay-container"),
    );
    const btn = visible.find((b) => (b.getAttribute("aria-label") ?? "").trim() === "Download scene");
    if (!btn) {
      return {
        ok: false,
        seen: [...new Set(visible.map((b) => (b.getAttribute("aria-label") ?? "").trim()).filter(Boolean))].slice(
          0,
          40,
        ),
      };
    }
    btn.click();
    return { ok: true, seen: [] as string[] };
  });
  if (!clicked.ok) {
    throw new FlowError(
      `Could not find the scene's "Download scene" button. Visible buttons: ${clicked.seen.join(" | ") || "(none)"}`,
      "Flow's scene view may have changed — see references/ui-playbook.md. Nothing was charged.",
    );
  }
  await page.waitForTimeout(900);
  const followUp = await page.evaluate(() => {
    const panes = [
      ...document.querySelectorAll<HTMLElement>(".cdk-overlay-pane,[role=dialog],[role=alertdialog]"),
    ].filter((p) => p.getClientRects().length > 0);
    const text = panes.map((p) => p.innerText.replace(/\s+/g, " ").trim()).join(" | ");
    if (/credit/i.test(text)) return { kind: "credit", text };
    const original = panes
      .flatMap((p) => [...p.querySelectorAll<HTMLElement>("[role=menuitem],button")])
      .find((e) => /Original size/i.test(e.innerText) && e.getAttribute("aria-disabled") !== "true");
    if (original) {
      original.click();
      return { kind: "menu", text };
    }
    return { kind: "none", text };
  });
  if (followUp.kind === "credit") {
    throw new FlowError(
      `Downloading the scene showed a prompt that mentions credits: "${followUp.text.slice(0, 200)}"`,
      "Nothing was clicked in it and nothing was charged. Exporting a scene should be free; check it in the browser.",
    );
  }
}

/**
 * The concat job reports SUCCESSFUL on a later poll than the one that starts it,
 * so we keep reading matching responses until one carries the payload.
 */
async function pollForEncodedVideo(
  first: Promise<import("playwright-core").Response | null>,
  timeoutMs: number,
): Promise<string> {
  const page = await getFlowPage();
  const deadline = Date.now() + timeoutMs;

  let response = await first;
  while (Date.now() < deadline) {
    if (response) {
      const encoded = await extractEncoded(response);
      if (encoded) return encoded;
    }
    response = await page
      .waitForResponse(
        (res) => new RegExp(KNOWN_PROCEDURES.concatenateStatus, "i").test(res.url()) && res.status() < 400,
        { timeout: Math.max(5_000, deadline - Date.now()) },
      )
      .catch(() => null);
    if (!response) break;
  }

  throw new FlowError(
    `Scene export did not return finished video data within ${Math.round(timeoutMs / 1000)}s.`,
    "The stitch itself is free, so nothing was charged. Check the scene in the browser and retry.",
  );
}

async function extractEncoded(response: import("playwright-core").Response): Promise<string | null> {
  try {
    const body = await response.json();
    return findEncodedVideo(body);
  } catch {
    return null;
  }
}

/**
 * SCENE ASSEMBLY (free)
 *
 * flow.google.com has no "create empty scene": the old top-bar "+" -> Create
 * Scene is gone (that menu now holds Upload / New collection / Create
 * character). A scene is a clip's editor — opening any video routes to
 * /project/<p>/edit/<id>, with a timeline, "Add clip" and Download. So a scene
 * is "created" by opening the clip it starts with. Only "Extend" charges, and
 * nothing here touches it.
 */
export async function createScene(firstClipMediaId: string): Promise<{ sceneId: string; url: string }> {
  const page = await getFlowPage();
  await assertNoStopSignal(page);
  const { editId, url } = await openVideoEditor(firstClipMediaId);
  return { sceneId: editId, url };
}

/**
 * Add library clips to the open scene editor, in order. Free.
 *
 * On flow.google.com the editor already holds its first clip, so every clip goes
 * through the timeline "+" popover — by exact "Add clip" label, never arrow keys,
 * because the popover's other item is the charged "Extend". Escape exits the
 * whole editor rather than closing the popover, so it is never used to dismiss.
 * UNVERIFIED on flow.google.com: the clip picker that "Add clip" opens has not
 * been observed; options are matched by media id or by the clip's /asb/ token.
 */
export async function addClipsToScene(
  mediaIds: string[],
): Promise<{ added: string[]; failed: string[]; sceneId: string | null; url: string }> {
  const page = await getFlowPage();
  await assertNoStopSignal(page);

  if (!/\/(edit|scene)\//.test(page.url())) {
    throw new FlowError(
      "The browser is not in a scene editor.",
      "Open one with flow_create_scene (it opens the first clip's editor), then add the rest. Nothing was charged.",
    );
  }

  const added: string[] = [];
  const failed: string[] = [];

  for (const mediaId of mediaIds) {
    const opened = /\/edit\//.test(page.url())
      ? await openTimelinePopover()
      : added.length === 0
        ? await clickByText("Add Clip", { exact: false, maxDescendants: 4 })
        : await openTimelinePopover();

    if (!opened) {
      failed.push(mediaId);
      continue;
    }
    await page.waitForTimeout(1_500);

    const picked = await page.evaluate(
      ({ id, token }) => {
        const option = [...document.querySelectorAll<HTMLElement>("[role=option],[role=listitem],li")].find((o) => {
          const img = o.querySelector("img");
          if (!img) return false;
          if (img.src.includes(id) || img.src.includes(encodeURIComponent(id))) return true;
          return token !== null && /\/asb\/([^=?/]+)/.exec(img.src)?.[1] === token;
        });
        if (!option) return false;
        option.click();
        return true;
      },
      { id: mediaId, token: null as string | null },
    );

    if (!picked) {
      failed.push(mediaId);
      continue;
    }

    await clickByText("Add to Scene", { exact: false, maxDescendants: 4 });
    await page.waitForTimeout(1_500);
    added.push(mediaId);
  }

  // Adding to a clip's editor creates a separate scene item and moves to it
  // (/scene/<id>); that id is what flow_export_scene needs.
  await page.waitForURL(/\/scene\//, { timeout: 10_000 }).catch(() => undefined);
  const sceneId = /\/scene\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? null;
  return { added, failed, sceneId, url: page.url() };
}

/**
 * Open the timeline "+" popover and choose "Add clip" BY EXACT LABEL.
 *
 * On flow.google.com (observed 2026-09-24) the popover holds exactly two items:
 * "Add clip" and "Extend (Veo 3.1 - Lite)" — the charged one. This used to press
 * ArrowDown + Enter blind; if focus started on the first item, that lands on
 * Extend and charges. Now it clicks only an item whose whole label is "Add clip",
 * rejects anything mentioning Extend, and backs out when neither matches.
 */
async function openTimelinePopover(): Promise<boolean> {
  const page = await getFlowPage();
  const opened = await page.evaluate(() => {
    const plus = [...document.querySelectorAll<HTMLElement>("button,[role=button]")]
      .filter((b) => b.getClientRects().length > 0 && !b.closest(".cdk-overlay-container"))
      .find((b) => /^(\+|add clip)$/i.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
    if (!plus) return false;
    plus.click();
    return true;
  });
  if (!opened) return false;

  await page.waitForTimeout(800);
  const picked = await page.evaluate(() => {
    const items = [
      ...document.querySelectorAll<HTMLElement>(
        ".cdk-overlay-pane button, .cdk-overlay-pane [role=menuitem], .cdk-overlay-pane [role=option]",
      ),
    ].filter((e) => e.getClientRects().length > 0);
    const label = (e: HTMLElement) =>
      (e.getAttribute("aria-label") || e.innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^add\s+/i, ""); // icon ligature
    const addClip = items.find((e) => !/extend/i.test(e.innerText) && /^add clip$/i.test(label(e)));
    if (!addClip) {
      document.querySelector<HTMLElement>(".cdk-overlay-backdrop")?.click();
      return false;
    }
    addClip.click();
    return true;
  });
  await page.waitForTimeout(800);
  return picked;
}

/**
 * The payload key nests differently across Flow releases, so search for it.
 * @internal exported for unit tests
 */
export function findEncodedVideo(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findEncodedVideo(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^encodedVideo$|encoded_video/i.test(k) && typeof v === "string" && v.length > 1000) return v;
    const found = findEncodedVideo(v, depth + 1);
    if (found) return found;
  }
  return null;
}
