import type { Bucket } from '../types.js';
import { SuppressedCountsStore } from '../state/suppressed-counts.service.js';
import type { SlackPoster } from './slack.service.js';

/**
 * Daily LOW-priority rollup poster (Dennis 2026-05-22 follow-up to PR #10).
 *
 * The 5-min digest poster suppresses NORMAL booking_question / general_info /
 * spam_out_of_scope batches and rolls them into `SuppressedCountsStore`.
 * Without a daily readout those counts would be invisible to operators.
 *
 * This service runs once per day at the configured time (default 08:00 UTC =
 * 09:00 Europe/Amsterdam year-round) and posts a single line to #team showing
 * yesterday's suppressed totals + bucket breakdown. Same channel operators
 * already watch.
 *
 * Idempotency: a `lastPostedAt` field in the counts store would let us guard
 * against double-posts within the same day. We skip that for v1 — node-cron
 * with a daily schedule never double-fires unless the process is restarted
 * exactly on the cron minute, which is rare enough to tolerate one duplicate.
 */

const BUCKET_DISPLAY: Record<Bucket, string> = {
  booking_question: 'booking_question',
  cancellation_request: 'cancellation_request',
  refund_request: 'refund_request',
  partner_issue: 'partner_issue',
  general_info: 'general_info',
  spam_out_of_scope: 'spam_out_of_scope',
  needs_human_review: 'needs_human_review',
};

export interface DailyRollupServiceDeps {
  store: SuppressedCountsStore;
  slack: SlackPoster;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Disable posting when there are zero suppressed mails to report.
   * Default true. Avoids "0 suppressed yesterday" noise in #team when
   * mailbox traffic is genuinely quiet.
   */
  skipPostOnZero?: boolean;
}

export class DailyRollupService {
  private readonly log: NonNullable<DailyRollupServiceDeps['log']>;
  private readonly skipPostOnZero: boolean;

  constructor(private readonly deps: DailyRollupServiceDeps) {
    this.log = deps.log ?? ((): void => {});
    this.skipPostOnZero = deps.skipPostOnZero ?? true;
  }

  /**
   * Run one rollup pass. Reports YESTERDAY's totals because the cron
   * fires at 09:00 local — by that hour the previous UTC day is complete.
   */
  async runOnce(now: Date = new Date()): Promise<void> {
    await this.deps.store.load();
    const yesterday = new Date(now.getTime() - 86_400_000);
    const entry = this.deps.store.getDay(yesterday);
    const total = entry?.totalSuppressed ?? 0;

    if (total === 0 && this.skipPostOnZero) {
      this.log('info', 'daily-rollup.skip.zero', {
        day: yesterday.toISOString().slice(0, 10),
      });
      return;
    }

    const text = buildDailyRollupMessage(yesterday, entry);
    try {
      await this.deps.slack.post(text);
      this.log('info', 'daily-rollup.posted', {
        day: yesterday.toISOString().slice(0, 10),
        total,
      });
    } catch (err) {
      this.log('error', 'daily-rollup.failed', { err: (err as Error).message });
    }
  }
}

export function buildDailyRollupMessage(
  day: Date,
  entry: { totalSuppressed: number; byBucket: Partial<Record<Bucket, number>> } | undefined,
): string {
  const dayLabel = day.toISOString().slice(0, 10);
  if (!entry || entry.totalSuppressed === 0) {
    return `:mailbox: Mailbox LOW-priority rollup ${dayLabel}: 0 suppressed (no routine traffic).`;
  }
  const lines = [
    `:mailbox: *Mailbox LOW-priority rollup ${dayLabel}*`,
    `${entry.totalSuppressed} routine mail${entry.totalSuppressed === 1 ? '' : 's'} suppressed from immediate #team posts. Bucket breakdown:`,
  ];
  const sorted = Object.entries(entry.byBucket).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  for (const [bucket, count] of sorted) {
    lines.push(`• ${count} ${BUCKET_DISPLAY[bucket as Bucket] ?? bucket}`);
  }
  lines.push(
    '_Time-sensitive buckets (cancellation/refund/partner/needs-human-review) and HIGH-priority items still posted immediately at the time they arrived._',
  );
  return lines.join('\n');
}
