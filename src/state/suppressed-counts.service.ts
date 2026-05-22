import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Bucket, ProcessedMail } from '../types.js';

/**
 * Persisted day-bucketed counts of LOW-priority mails that were suppressed
 * from the immediate #team digest post.
 *
 * Why this exists — Dennis 2026-05-22:
 *   "Ensure normal/LOW counts are available to the 09:00 morning digest/audit."
 *   The 09:00 morning digest (server-claude-worker autoremediate.morning_digest)
 *   runs on a different host, but operators can read this state file to see
 *   the rolled-up LOW activity. A future PR can wire it to the morning digest
 *   directly. For now: this file is the truth, never silently dropped, and
 *   inspectable via `cat /var/lib/mailbox-monitor/suppressed-counts.json`.
 *
 * Schema:
 *   {
 *     "2026-05-22": {
 *        "totalSuppressed": 12,
 *        "byBucket": { "booking_question": 10, "general_info": 2 },
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

  add(mails: ProcessedMail[], now: Date): void {
    if (!this.loaded) throw new Error('SuppressedCountsStore: load() not called');
    if (mails.length === 0) return;
    const day = dayUtc(now);
    const entry =
      this.data[day] ??
      ({ totalSuppressed: 0, byBucket: {}, lastSuppressedAt: now.toISOString() } as SuppressedCountsByDay[string]);
    entry.totalSuppressed += mails.length;
    for (const m of mails) {
      entry.byBucket[m.bucket] = (entry.byBucket[m.bucket] ?? 0) + 1;
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
