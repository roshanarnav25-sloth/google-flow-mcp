/**
 * Every literal that Google can change out from under us lives here, so drift is
 * a one-file fix rather than a scavenger hunt.
 */

/**
 * Flow moved from labs.google/fx/tools/flow (a Next.js + tRPC app) to its own
 * origin, flow.google.com (an Angular app speaking Google's batchexecute RPC),
 * in September 2026. Old project links redirect; old API paths do not.
 */
export const FLOW_ORIGIN = "https://flow.google.com";
export const FLOW_HOME = `${FLOW_ORIGIN}/`;
export const projectUrl = (projectId: string): string => `${FLOW_ORIGIN}/project/${projectId}`;

/** True for any page on the current Flow origin. */
export function isFlowUrl(url: string): boolean {
  try {
    return new URL(url).hostname === new URL(FLOW_ORIGIN).hostname;
  } catch {
    return false;
  }
}

/**
 * Legacy tRPC proxy on the old origin. Nothing on flow.google.com serves it; kept
 * only so the discovery/HTTP-tier code still compiles. Media is now read from
 * the grid's signed CDN urls instead.
 */
export const LEGACY_ORIGIN = "https://labs.google";
export const TRPC_BASE = `${LEGACY_ORIGIN}/fx/api/trpc`;

/** Signed CDN that actually serves rendered media. Never carries auth cookies. */
export const CDN_HOST_PATTERN = /flow-content\.google/;

/** Hosts worth recording during API discovery. */
export const DISCOVERY_HOST_PATTERNS: RegExp[] = [
  /flow\.google\.com\/_\/[^/]+\/data\/batchexecute/,
  /labs\.google\/fx\/api\//,
  /aisandbox-pa\.googleapis\.com/,
  CDN_HOST_PATTERN,
];

/**
 * Verified procedure names. Anything not in this list must be learned by
 * `flow_discover_api` rather than guessed — a wrong mutation name can charge.
 */
export const KNOWN_PROCEDURES = {
  // NOTE: these are the legacy labs.google tRPC names. None are served on
  // flow.google.com; scene export still depends on them and is unverified.
  /** GET ?name=<mediaId> -> 302 to a signed CDN url. Verified 2026-07-09. */
  mediaUrlRedirect: "media.getMediaUrlRedirect",
  /** Scenebuilder export job. Verified 2026-07-10. */
  concatenate: "runVideoFxConcatenation",
  /** Scenebuilder export poll; response carries base64 `encodedVideo`. */
  concatenateStatus: "CheckConcatenationStatus",
} as const;

/** Credit cost table. Source: support.google.com/flow/answer/16526234 + live observation. */
export const CREDIT_COSTS: Record<string, number> = {
  still: 0,
  "veo-3.1-lite": 10,
  "veo-3.1-fast": 20,
  "veo-3.1-quality": 100,
  "scenebuilder-extend": 40,
  "upscale-1080p": 0,
  "upscale-4k": 50,
};

/** Refuse to approve anything above this, whatever the caller passes. */
export const ABSOLUTE_COST_CEILING = 100;

/** Empirical first-try acceptance on Veo 3.1 (~70%) -> budget 1.4 takes per clip. */
export const RETRY_BUDGET_MULTIPLIER = 1.4;

export const TIMEOUTS = {
  /** Proposal card with a quoted cost should appear within this. */
  quoteMs: 90_000,
  /** Video render. Playbook says 1-3+ min; allow slack, never resubmit. */
  renderMs: 480_000,
  /** Stills are fast and free. */
  stillMs: 180_000,
  /** Any single in-page evaluate. */
  evalMs: 30_000,
  /** Scenebuilder concat export. */
  exportMs: 300_000,
};

export const POLL_INTERVAL_MS = 5_000;

/** The composer's settings popover states the price before anything is sent. */
export const COMPOSER_QUOTE_PATTERN = /Generating will use\s+([\d,]+)\s+credits?/i;

/**
 * Page text that means "stop and hand back to a human". Matched case-insensitively
 * against body text before and after every charged action.
 */
export const STOP_SIGNALS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /verify it'?s you|use your passkey|sign in to continue|choose an account/i,
    reason: "re-authentication wall",
  },
  {
    pattern: /upgrade to (google ai )?(pro|ultra)|you'?re out of credits|no credits remaining/i,
    reason: "paywall or credit exhaustion",
  },
  { pattern: /unusual traffic|are you a robot|i'?m not a robot/i, reason: "bot challenge" },
  // Seen on a failed generation tile, 2026-09-24: Flow's abuse detection. Stop and
  // hand back to the human rather than generating into it.
  { pattern: /noticed some unusual activity/i, reason: "Flow flagged unusual activity on the account" },
];

/** Magic-byte signatures, so a 401 JSON body never gets saved as a .jpg. */
export const FILE_SIGNATURES: { ext: string; test: (b: Buffer) => boolean }[] = [
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "webp", test: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  { ext: "mp4", test: (b) => b.subarray(4, 8).toString() === "ftyp" },
];

export const MIN_MEDIA_BYTES = 10_000;
