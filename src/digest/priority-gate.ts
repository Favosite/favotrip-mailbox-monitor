import type { Bucket, ProcessedMail } from '../types.js';

/**
 * LOW-priority suppression gate for the #team digest poster.
 *
 * Background — Dennis 2026-05-22 standing-mandate fix:
 *   The 5-min cron was posting a `Klantenservice digest` to #team for every
 *   batch with `processed.length > 0`, including batches that contained only
 *   a single plain `booking_question`. This caused 5-minute interruptions
 *   in #team for routine traffic. Customer-impacting items (HIGH priority,
 *   manipulation flags, P0/P1 keyword hits, cancellation/refund/partner
 *   buckets) must still post immediately; only the routine no-signal mails
 *   get suppressed and rolled into the 09:00 morning digest instead.
 *
 * Bucket policy:
 *   booking_question   - suppressible when NORMAL (routine info request)
 *   general_info       - suppressible when NORMAL (routine)
 *   spam_out_of_scope  - suppressible when NORMAL (no human action needed)
 *   cancellation_request - ALWAYS immediate (customer-impact, time-sensitive)
 *   refund_request       - ALWAYS immediate (money, time-sensitive)
 *   partner_issue        - ALWAYS immediate (internal escalation)
 *   needs_human_review   - ALWAYS immediate (classifier uncertain)
 *
 * A mail is "suppressible" only when ALL of the following hold:
 *   - bucket ∈ LOW_BUCKETS             (only low-information buckets)
 *   - priority === 'NORMAL'            (no manipulation flag, no keyword hit)
 *   - keywordHit is null/undefined     (belt-and-braces, encoded in priority)
 *   - flags.length === 0               (belt-and-braces, encoded in priority)
 *   - manualOnly === false             (manual-only mails are PII-redacted
 *                                       but still demand human eyes)
 *
 * The redundancy with `priority === 'NORMAL'` is intentional: if a future
 * refactor decouples the priority calculation from these signals, this gate
 * stays correct.
 *
 * Suppression applies ONLY to the #team digest poster. The #alerts keyword
 * pipeline (KeywordAlertService) and the queue-task dispatcher are
 * unaffected.
 */
export const LOW_BUCKETS: ReadonlySet<Bucket> = new Set<Bucket>([
  'booking_question',
  'general_info',
  'spam_out_of_scope',
]);

export function isLowSuppressible(m: ProcessedMail): boolean {
  if (!LOW_BUCKETS.has(m.bucket)) return false;
  if (m.priority !== 'NORMAL') return false;
  if (m.keywordHit) return false;
  if (m.flags.length > 0) return false;
  if (m.manualOnly) return false;
  return true;
}

/**
 * True when every mail in the batch is LOW-suppressible. Empty batches
 * return false so the existing zero-mail rate-limit path stays the single
 * source of truth for the "0 mails" branch in the runner.
 */
export function isAllLowPriority(mails: ProcessedMail[]): boolean {
  if (mails.length === 0) return false;
  return mails.every(isLowSuppressible);
}
