import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KeywordHit, KeywordSeverity } from '../classifier/keyword-monitor.service.js';
import type { ProcessedMail } from '../types.js';
import type { SlackPoster } from './slack.service.js';

/**
 * Keyword-alert dedupe store.
 *
 * Spec: emit at most ONE Slack post per (severity, thread-id, day_utc).
 *
 * Thread-id derivation: we don't currently carry Gmail Message-ID /
 * References headers through ImapFetchService — extending those types
 * would touch the read-path. As a stand-in, we hash:
 *   sha256(salt | fromHash | normalised-subject)
 * where normalised-subject strips `Re:`/`Fwd:`/`Antw:` prefixes and
 * whitespace, so reply-chains under the same subject from the same
 * sender (already a per-sender hash, salt-bound) collapse to one
 * thread-id. Subject is the MASKED subject so we never persist PII.
 *
 * Dedupe key = `${severity}|${threadId}|${dayUtc}`. The day_utc rolls
 * over at midnight UTC so a customer can re-trigger an alert tomorrow
 * if the issue persists (which is what we want — not silent forever).
 *
 * Retention: keys older than 14 days are pruned on save() so the file
 * doesn't grow unbounded. The (sev,thread,day) tuple is naturally
 * day-scoped so prune-by-day is sufficient.
 */
export interface KeywordDedupeFile {
  /** Map of dedupe key -> ISO timestamp of first emission. */
  emitted: Record<string, string>;
}

const RE_PREFIX_RE = /^(?:(?:re|fwd?|antw|aw|sv|tr)\s*:\s*)+/i;

function normaliseSubject(masked: string): string {
  return masked.replace(RE_PREFIX_RE, '').trim().toLowerCase();
}

export function computeThreadId(fromHash: string, maskedSubject: string, salt: string): string {
  const h = createHash('sha256');
  h.update(salt);
  h.update('|');
  h.update(fromHash);
  h.update('|');
  h.update(normaliseSubject(maskedSubject));
  return h.digest('hex').slice(0, 16);
}

export function computeDedupeKey(
  severity: KeywordSeverity,
  threadId: string,
  date: Date,
): string {
  const dayUtc = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return `${severity}|${threadId}|${dayUtc}`;
}

export class KeywordDedupeStore {
  private data: KeywordDedupeFile = { emitted: {} };
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<KeywordDedupeFile>;
      this.data = { emitted: parsed.emitted ?? {} };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      this.data = { emitted: {} };
    }
    this.loaded = true;
  }

  has(key: string): boolean {
    if (!this.loaded) throw new Error('KeywordDedupeStore: load() not called');
    return Object.prototype.hasOwnProperty.call(this.data.emitted, key);
  }

  mark(key: string, at: Date): void {
    if (!this.loaded) throw new Error('KeywordDedupeStore: load() not called');
    this.data.emitted[key] = at.toISOString();
  }

  /** Drop entries whose ts is older than `keepDays`. */
  prune(now: Date, keepDays = 14): void {
    if (!this.loaded) throw new Error('KeywordDedupeStore: load() not called');
    const cutoffMs = now.getTime() - keepDays * 86400_000;
    for (const [k, ts] of Object.entries(this.data.emitted)) {
      const d = Date.parse(ts);
      if (Number.isFinite(d) && d < cutoffMs) {
        delete this.data.emitted[k];
      }
    }
  }

  async save(): Promise<void> {
    if (!this.loaded) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

const SEVERITY_ICON: Record<KeywordSeverity, string> = {
  P0: ':rotating_light:',
  P1: ':warning:',
};

const SEVERITY_TITLE: Record<KeywordSeverity, string> = {
  P0: 'P0 mailbox-keyword: customer cannot complete payment',
  P1: 'P1 mailbox-keyword: customer cannot book / voucher unusable',
};

export interface KeywordAlertInput {
  mail: ProcessedMail;
  hit: KeywordHit;
  threadId: string;
}

/**
 * Build the Slack message body for a single keyword alert. No
 * @-mentions (per CLAUDE.md regel 1: #alerts is no-tag). PII never
 * exceeds what's already in `ProcessedMail` — maskedFrom + maskedSubject
 * + first 120 chars of maskedBody.
 */
export function buildKeywordAlertMessage(input: KeywordAlertInput, now: Date = new Date()): string {
  const { mail, hit, threadId } = input;
  const icon = SEVERITY_ICON[hit.severity];
  const title = SEVERITY_TITLE[hit.severity];

  const subjectTrim = (mail.maskedSubject ?? '').slice(0, 80);
  const bodyQuote = mail.manualOnly
    ? '[REDACTED — manual-only: contains sensitive financial or medical content]'
    : (mail.maskedBody ?? '').slice(0, 120).replace(/\s+/g, ' ').trim();

  const receivedUtc = formatUtc(mail.date ?? now);
  const keywordsJson = JSON.stringify(hit.keywords);

  const lines = [
    `${icon} *${title}*`,
    `- from: ${mail.maskedFrom}`,
    `- subject: ${subjectTrim}`,
    `- received: ${receivedUtc} UTC`,
    `- keywords hit: ${keywordsJson}`,
    `- mail-quote: ${bodyQuote}`,
    `- thread-id: ${threadId}`,
    `_Runbook:_ ${hit.runbook}`,
    `_via_ Claude (mailbox-monitor keyword classifier)`,
  ];
  return lines.join('\n');
}

function formatUtc(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

export interface KeywordAlertServiceDeps {
  poster: SlackPoster;
  store: KeywordDedupeStore;
  salt: string;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export interface KeywordAlertBatchResult {
  emitted: number;
  skippedDedupe: number;
  errors: number;
}

/**
 * Service that orchestrates dedupe + post for a batch of mails that
 * already carry an attached `keywordHit`. The caller is the runner;
 * the pipeline produces ProcessedMail.keywordHit, the runner asks this
 * service to flush any non-deduped alerts.
 *
 * Errors are swallowed per-alert so one bad post doesn't crash the
 * 5-minute mailbox cycle (same pattern as QueueTaskDispatcher).
 */
export class KeywordAlertService {
  private readonly log: NonNullable<KeywordAlertServiceDeps['log']>;
  constructor(private readonly deps: KeywordAlertServiceDeps) {
    this.log = deps.log ?? ((): void => {});
  }

  async flush(mails: ProcessedMail[], now: Date = new Date()): Promise<KeywordAlertBatchResult> {
    const result: KeywordAlertBatchResult = { emitted: 0, skippedDedupe: 0, errors: 0 };

    for (const m of mails) {
      if (!m.keywordHit) continue;
      const threadId = computeThreadId(m.fromHash, m.maskedSubject, this.deps.salt);
      const key = computeDedupeKey(m.keywordHit.severity, threadId, m.date);

      if (this.deps.store.has(key)) {
        result.skippedDedupe += 1;
        this.log('info', 'keyword.alert.dedupe.skip', { key });
        continue;
      }

      const text = buildKeywordAlertMessage({ mail: m, hit: m.keywordHit, threadId }, now);
      try {
        await this.deps.poster.post(text);
        this.deps.store.mark(key, now);
        result.emitted += 1;
        this.log('info', 'keyword.alert.posted', {
          severity: m.keywordHit.severity,
          threadId,
        });
      } catch (err) {
        result.errors += 1;
        this.log('error', 'keyword.alert.failed', { err: (err as Error).message });
      }
    }

    return result;
  }
}
