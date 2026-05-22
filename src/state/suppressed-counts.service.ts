import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Bucket, ProcessedMail } from '../types.js';
import type { ClassifiedMail, SuppressReason } from '../digest/interrupt-policy.js';

/**
 * Persisted day-bucketed counts of suppressed mails (from the immediate
 * #team digest post).
 *
 * Why this exists — Dennis 2026-05-22:
 *   "Ensure normal/LOW counts are available to the 09:00 morning digest/audit."
 *   The 09:00 morning digest (server-claude-worker autoremediate.morning_digest)
 *   runs on a different host, but operators can read this state file to see
 *   the rolled-up activity. A future PR can wire it to the morning digest
 *   directly. For now: this file is the truth, never silently dropped, and
 *   inspectable via `cat /var/lib/mailbox-monitor/suppressed-counts.json`.
 *
 * Iteration 2 (Dennis 2026-05-22 second feedback):
 *   `byReason` was added alongside `byBucket` to surface WHY mails were
 *   suppressed (not just that they were). Operators can now see if a day's
 *   suppression was driven by repeated_mailer noise, needs_human_review
 *   without urgent keywords, or genuine LOW traffic. Missing `byReason`
 *   field on legacy entries reads back as an empty object (backward
 *   compatible with PR #10 schema).
 *
 * Schema:
 *   {
 *     "2026-05-22": {
 *        "totalSuppressed": 12,
 *        "byBucket": { "booking_question": 10, "general_info": 2 },
 *        "byReason": { "low_priority": 8, "repeated_mailer_only": 3,
 *                      "needs_human_review_nonurgent": 1 },
 *        "lastSuppressedAt": "2026-05-22T10:35:01.000Z"
 *      },
 *      ...
 *   }
 *
 * Retention: rolling 14 days, pruned on save().
 */
export interface SuppressedCountsByDay {
  [dayUtc: string]: {
    totalSuppressed: number;
    byBucket: Partial<Record<Bucket, number>>;
    byReason: Partial<Record<SuppressReason, number>>;
    lastSuppressedAt: string;
  };
}

const KEEP_DAYS = 14;

function dayUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class SuppressedCountsStore {
  private data: SuppressedCountsByDay = {};
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as SuppressedCountsByDay;
      this.data = parsed ?? {};
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      this.data = {};
    }
    this.loaded = true;
  }

  /**
   * Add suppressed mails to today's counters. Accepts EITHER a bare
   * ProcessedMail[] (legacy PR #10 callers — every entry counted under
   * the generic 'low_priority' reason) OR a ClassifiedMail[] (this-PR
   * callers — reason captured per mail). The dual signature keeps the
   * test surface stable for PR #10 tests while the runner upgrades.
   */
  add(mails: ProcessedMail[] | ClassifiedMail[], now: Date): void {
    if (!this.loaded) throw new Error('SuppressedCountsStore: load() not called');
    if (mails.length === 0) return;
    const day = dayUtc(now);
    const entry =
      this.data[day] ??
      ({
        totalSuppressed: 0,
        byBucket: {},
        byReason: {},
        lastSuppressedAt: now.toISOString(),
      } as SuppressedCountsByDay[string]);
    // byReason field may be missing on legacy entries loaded from disk
    // (PR #10 schema). Initialise lazily so we don't crash when adding to
    // a day's entry that pre-dates this iteration.
    if (!entry.byReason) entry.byReason = {};

    entry.totalSuppressed += mails.length;
    for (const item of mails) {
      if ('mail' in item) {
        // ClassifiedMail
        const bucket = item.mail.bucket;
        entry.byBucket[bucket] = (entry.byBucket[bucket] ?? 0) + 1;
        entry.byReason[item.reason] = (entry.byReason[item.reason] ?? 0) + 1;
      } else {
        // Bare ProcessedMail (legacy)
        entry.byBucket[item.bucket] = (entry.byBucket[item.bucket] ?? 0) + 1;
        entry.byReason['low_priority'] =
          (entry.byReason['low_priority'] ?? 0) + 1;
      }
    }
    entry.lastSuppressedAt = now.toISOString();
    this.data[day] = entry;
  }

  getDay(now: Date): SuppressedCountsByDay[string] | undefined {
    if (!this.loaded) throw new Error('SuppressedCountsStore: load() not called');
    return this.data[dayUtc(now)];
  }

  /** All days currently in store, sorted ascending. */
  listDays(): string[] {
    if (!this.loaded) throw new Error('SuppressedCountsStore: load() not called');
    return Object.keys(this.data).sort();
  }

  prune(now: Date, keepDays = KEEP_DAYS): void {
    if (!this.loaded) throw new Error('SuppressedCountsStore: load() not called');
    const cutoffMs = now.getTime() - keepDays * 86_400_000;
    for (const day of Object.keys(this.data)) {
      const ts = Date.parse(day + 'T00:00:00Z');
      if (Number.isFinite(ts) && ts < cutoffMs) {
        delete this.data[day];
      }
    }
  }

  async save(): Promise<void> {
    if (!this.loaded) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
}
