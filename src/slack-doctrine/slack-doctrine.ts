/**
 * slack-doctrine.ts - TypeScript port of server-claude-worker's
 * `scripts/monitors/slack_post.py` content cooldown and tech-refs guard.
 * The state shape stays aligned so both implementations can share the
 * same operational expectations.
 *
 * The doctrine is applied ONLY to top-level #team posts (`channel ===
 * CHANNEL_TEAM` and no thread_ts). #alerts and thread replies pass through
 * untouched.
 *
 * The content gate (SUPPRESSED_CONTENT_DUPLICATE) is a 30-minute
 * cooldown keyed on sha256(channel || normalized_text). Normalization
 * strips volatile bits (mentions <@U…>, ISO timestamps, Slack TS-floats,
 * URLs) and collapses whitespace + lowercases so the same explainer
 * posted 3× with different timestamps still collides on one key.
 *
 * Defensive guard (BLOCKED_TECH_REFS_IN_TEAM): any `_Technical refs:`
 * footer in a #team body is blocked outright — mirrors the worker
 * wrapper R4 contract.
 *
 * State semantics:
 *   - evaluate() is sync and operates under an exclusive file lock so
 *     concurrent callers cannot race the cooldown register.
 *   - Content cooldown is REGISTERED inside evaluate() on the SUCCESS
 *     path (post=true) BEFORE the caller actually posts. This mirrors
 *     the Python wrapper's "record first, then post — undercount beats
 *     double-post" tradeoff. If the caller's downstream POST fails, a
 *     follow-up retry within 30 min is suppressed. Acceptable: better
 *     to lose one post than to spam Slack on a transient network blip.
 *
 * No I/O happens in evaluate() beyond the state-file lock + read/write
 * + cooldown JSON. No HTTP. No Slack calls. Pure decision logic with
 * a tiny persistent state side-effect.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

// === Channel constants =================================================
// Mirror server-claude-worker post_policy.CHANNEL_TEAM / CHANNEL_ALERTS.
// Hard-coded as canonical IDs so a TS consumer can't drift them by
// accident; if Slack channel IDs ever change globally, both impls update
// in lockstep.

export const CHANNEL_TEAM = 'C0ARU879A93';
export const CHANNEL_ALERTS = 'C0AQPR9ECE9';

// === Doctrine constants ===============================================

/** Cooldown window for content dedupe - 30 min, mirrors Python. */
export const CONTENT_COOLDOWN_WINDOW_SECONDS = 30 * 60;

// === Status enums ======================================================

export type DoctrineStatus =
  | 'SENT'
  | 'SUPPRESSED_CONTENT_DUPLICATE'
  | 'BLOCKED_TECH_REFS_IN_TEAM';

export type DoctrineDecision =
  | {
      post: true;
      status: 'SENT';
      /** What to post to the original channel. Always the original text. */
      text: string;
      dedupKey: string;
      reason: string;
    }
  | {
      post: false;
      status: 'SUPPRESSED_CONTENT_DUPLICATE' | 'BLOCKED_TECH_REFS_IN_TEAM';
      reason: string;
      dedupKey?: string;
    };

export interface EvaluateInput {
  channel: string;
  text: string;
  /** Optional thread parent TS — if present the post is a thread reply
   *  and bypasses the policy checks (per Python wrapper semantics). */
  threadTs?: string;
  /** Path to the JSON state file that backs the content cooldown. */
  stateFile: string;
  /** Override for CONTENT_COOLDOWN_WINDOW_SECONDS (tests only). */
  contentCooldownSec?: number;
  /** Injectable clock for deterministic tests. Returns unix-seconds. */
  now?: () => number;
}

// === Regex helpers =====================================================

const TECH_REFS_FOOTER_TOKEN = '_Technical refs:';

// Variable-content patterns we strip before hashing — keep in lockstep
// with the Python wrapper's _NORM_*_RE expressions.
const NORM_MENTION_RE = /<@U[A-Z0-9]+>/g;
const NORM_ISO_TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?/g;
const NORM_SLACK_TS_RE = /\d{10}\.\d{3,6}/g;
const NORM_URL_RE = /https?:\/\/\S+/g;
const NORM_WS_RE = /\s+/g;

// === Pure helpers (exported for unit tests) ============================

export function normalizeForContentHash(text: string): string {
  if (!text) return '';
  let t = text;
  t = t.replace(NORM_MENTION_RE, '');
  t = t.replace(NORM_ISO_TS_RE, '');
  t = t.replace(NORM_SLACK_TS_RE, '');
  t = t.replace(NORM_URL_RE, '');
  t = t.replace(NORM_WS_RE, ' ').trim().toLowerCase();
  return t;
}

export function contentDedupKey(channel: string, text: string): string {
  const norm = normalizeForContentHash(text);
  return createHash('sha256').update(`${channel}|content|${norm}`).digest('hex').slice(0, 16);
}

// === State file (cooldown register) ====================================
// JSON shape: { "<dedupKey>": <unix-seconds-of-last-post>, ... }

type ContentCooldownState = Record<string, number>;

function readState(stateFile: string): ContentCooldownState {
  if (!existsSync(stateFile)) return {};
  try {
    const raw = readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ContentCooldownState;
    }
    return {};
  } catch {
    return {};
  }
}

function writeStateAtomic(stateFile: string, state: ContentCooldownState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = stateFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, stateFile);
}

function pruneState(
  state: ContentCooldownState,
  windowSeconds: number,
  nowSec: number,
): ContentCooldownState {
  const cutoff = nowSec - 2 * windowSeconds;
  const out: ContentCooldownState = {};
  for (const [k, v] of Object.entries(state)) {
    if (v > cutoff) out[k] = v;
  }
  return out;
}

// === Lock primitive ====================================================
// Simple sync exclusive-create lock with brief retry. We don't have
// `fcntl.flock` in Node's stdlib, but `open(O_EXCL)` is atomic and
// posix-portable. Hold time is microseconds (read JSON, decide, write
// JSON) so contention is rare even at high cron-tick rates.

function acquireLockSync(lockFile: string, maxAttempts = 200, sleepMs = 5): number {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return openSync(lockFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw err;
      // Busy-wait briefly. Real concurrent contention is rare; this loop
      // mostly protects against rare stale-lock recovery (see below).
      const until = Date.now() + sleepMs;
      while (Date.now() < until) {
        /* spin */
      }
      // Stale-lock recovery: if the lock has been held longer than
      // 10s, assume the previous holder crashed before releasing and
      // remove it. 10s is generous — actual hold time is sub-ms.
      if (i === 50) {
        try {
          const fd = openSync(lockFile, 'r');
          closeSync(fd);
          // best-effort: if the file is older than 10s, unlink it
          const { statSync } = require('node:fs') as typeof import('node:fs');
          const stat = statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 10_000) {
            unlinkSync(lockFile);
          }
        } catch {
          /* fine — try again next iteration */
        }
      }
    }
  }
  throw new Error(`slack-doctrine: could not acquire lock on ${lockFile} after ${maxAttempts} attempts`);
}

function releaseLockSync(fd: number, lockFile: string): void {
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lockFile);
  } catch {
    /* ignore — best-effort */
  }
}

function withStateLock<T>(stateFile: string, fn: () => T): T {
  mkdirSync(dirname(stateFile), { recursive: true });
  const lockFile = stateFile + '.lock';
  const fd = acquireLockSync(lockFile);
  try {
    return fn();
  } finally {
    releaseLockSync(fd, lockFile);
  }
}

// === Main entry point ==================================================

/**
 * Apply the content cooldown and tech-refs guard to a Slack post.
 *
 * Returns a DoctrineDecision. The caller is responsible for:
 *   - On `post: true`: post `decision.text` to `channel` unchanged.
 *   - On `post: false`: do not post; write a suppression audit row.
 *
 * Policy checks are applied ONLY when `channel === CHANNEL_TEAM` and
 * there is no `threadTs`. Posts to other channels or thread replies pass
 * through unconditionally with status=SENT.
 */
export function evaluate(input: EvaluateInput): DoctrineDecision {
  const text = input.text ?? '';
  const channel = input.channel;
  const threadTs = input.threadTs;
  const cooldownSec = input.contentCooldownSec ?? CONTENT_COOLDOWN_WINDOW_SECONDS;
  const nowSec = (input.now ?? (() => Math.floor(Date.now() / 1000)))();

  // Policy checks only fire for top-level #team posts. Anything else passes through.
  const gatedChannel = channel === CHANNEL_TEAM && threadTs === undefined;

  // Defensive guard: never let `_Technical refs:` leak to #team top-level.
  // Mirrors the Python wrapper R4 contract.
  if (gatedChannel && text.includes(TECH_REFS_FOOTER_TOKEN)) {
    return {
      post: false,
      status: 'BLOCKED_TECH_REFS_IN_TEAM',
      reason: '#team top-level posts may not contain _Technical refs: footer (doctrine R4)',
    };
  }

  if (!gatedChannel) {
    // Non-#team or thread reply — skip policy checks entirely.
    return {
      post: true,
      status: 'SENT',
      text,
      dedupKey: contentDedupKey(channel, text),
      reason: 'channel not gated by doctrine (not top-level #team)',
    };
  }

  // Content cooldown + register-on-success run under an exclusive lock
  // so concurrent callers cannot race the cooldown window.
  return withStateLock(input.stateFile, () => {
    let state = readState(input.stateFile);
    state = pruneState(state, cooldownSec, nowSec);

    const dedupKey = contentDedupKey(channel, text);
    const lastSeen = state[dedupKey] ?? 0;

    // Content cooldown
    if (lastSeen > 0 && nowSec - lastSeen < cooldownSec) {
      const seenAgo = nowSec - lastSeen;
      return {
        post: false,
        status: 'SUPPRESSED_CONTENT_DUPLICATE',
        reason:
          `normalized content matches a #team post sent ${seenAgo}s ago ` +
          `(<${cooldownSec}s window) — suppressing duplicate`,
        dedupKey,
      } as DoctrineDecision;
    }

    // Pass-through: register cooldown + return SENT.
    state[dedupKey] = nowSec;
    writeStateAtomic(input.stateFile, state);
    return {
      post: true,
      status: 'SENT',
      text,
      dedupKey,
      reason: 'allowed by doctrine',
    };
  });
}
