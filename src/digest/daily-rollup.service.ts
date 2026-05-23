import type { Bucket } from '../types.js';
import type { SuppressReason } from './interrupt-policy.js';
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

/**
 * Build the #team daily-rollup message for yesterday's suppressed-mail
 * counts.
 *
 * Dennis 2026-05-23 rollup-formatting spec:
 *   - If only routine mails were suppressed and no human action is
 *     needed → AT MOST one line: `📫 Mailbox rollup …: N routine mails
 *     onderdrukt. Geen actie nodig.`
 *   - No bucket breakdown top-level in #team.
 *   - No reason breakdown top-level in #team.
 *   - No "which signals still post immediately" explanation.
 *   - Owner-actionable batches are handled by digest.service.buildDigestMessage,
 *     not by this rollup.
 *
 * The bucket + reason breakdown still lives in SuppressedCountsStore
 * (state file) and in the structured `daily-rollup.detailed` log line
 * the runner emits. Operators who want detail can grep the log or open
 * `audit/suppressed-counts.json`. No top-level #team rendering of it.
 */
export function buildDailyRollupMessage(
  day: Date,
  entry:
    | {
        totalSuppressed: number;
        byBucket: Partial<Record<Bucket, number>>;
        byReason?: Partial<Record<SuppressReason, number>>;
      }
    | undefined,
): string {
  // Suppress reference to BUCKET_DISPLAY / REASON_DISPLAY at the
  // top-level renderer — they're kept for the structured-log path only.
  void BUCKET_DISPLAY;
  const dayLabel = day.toISOString().slice(0, 10);
  const total = entry?.totalSuppressed ?? 0;
  if (total === 0) {
    return `:mailbox: Mailbox rollup ${dayLabel}: 0 routine mails onderdrukt. Geen actie nodig.`;
  }
  const mailWord = total === 1 ? 'mail' : 'mails';
  return `:mailbox: Mailbox rollup ${dayLabel}: ${total} routine ${mailWord} onderdrukt. Geen actie nodig.`;
}

/**
 * Structured-log payload for the bucket + reason breakdown. Emitted
 * alongside the #team post (by the runner) so operators can grep logs
 * or pipe the JSON to #claude-agent-trace later if needed.
 *
 * Returns null when there's nothing to log (zero suppressed).
 */
export function buildDailyRollupDetail(
  day: Date,
  entry:
    | {
        totalSuppressed: number;
        byBucket: Partial<Record<Bucket, number>>;
        byReason?: Partial<Record<SuppressReason, number>>;
      }
    | undefined,
): Record<string, unknown> | null {
  if (!entry || entry.totalSuppressed === 0) return null;
  const dayLabel = day.toISOString().slice(0, 10);
  const byBucketRendered: Record<string, number> = {};
  for (const [bucket, count] of Object.entries(entry.byBucket)) {
    byBucketRendered[BUCKET_DISPLAY[bucket as Bucket] ?? bucket] = count ?? 0;
  }
  const byReasonRendered: Record<string, number> = {};
  for (const [reason, count] of Object.entries(entry.byReason ?? {})) {
    byReasonRendered[reason] = count ?? 0;
  }
  return {
    day: dayLabel,
    totalSuppressed: entry.totalSuppressed,
    byBucket: byBucketRendered,
    byReason: byReasonRendered,
  };
}

// Retained for backwards compatibility with the detail-logger; not used
// by the new buildDailyRollupMessage.
export const _REASON_DISPLAY: Record<SuppressReason, string> = {
  low_priority: 'routine LOW (booking_question / general_info / spam)',
  repeated_mailer_only: 'repeated_mailer noise (no content urgency)',
  manual_only_nonurgent: 'manual-only without urgent keyword (PII redacted)',
  needs_human_review_nonurgent: 'needs_human_review without urgent keyword',
  other_routine: 'other routine',
};
