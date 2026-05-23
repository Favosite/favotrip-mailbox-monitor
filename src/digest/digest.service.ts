import type { Bucket, DigestStats, ProcessedMail } from '../types.js';
import { classifyInterrupt } from './interrupt-policy.js';

/**
 * Slack user-ID for Jeanne (klantenservice lead). Used as the owner-tag
 * in actionable #team posts so per CLAUDE.md 5-point doctrine line 1 is
 * `<@U07TM7DKMUF> ACTION: …`. Mirrors server-claude-worker constants.
 */
export const JEANNE_SLACK_UID = 'U07TM7DKMUF';

export function buildStats(mails: ProcessedMail[]): DigestStats {
  const byBucket: Partial<Record<Bucket, number>> = {};
  let highPriorityCount = 0;
  let manualOnlyCount = 0;
  for (const m of mails) {
    byBucket[m.bucket] = (byBucket[m.bucket] ?? 0) + 1;
    if (m.priority === 'HIGH') highPriorityCount++;
    if (m.manualOnly) manualOnlyCount++;
  }
  return { total: mails.length, byBucket, highPriorityCount, manualOnlyCount };
}

/**
 * Normalise an interrupt-decision detail into a short Dutch reason
 * fragment suitable for a single ACTION line. Reasons must be
 * customer-recognisable and short. Examples:
 *   bucket=cancellation_request  -> "annulering"
 *   bucket=refund_request        -> "refund"
 *   bucket=partner_issue         -> "partner-issue"
 *   flags=legal_threat           -> "juridisch"
 *   flags=chargeback             -> "chargeback"
 *   flags=sob_story_money        -> "financieel"
 *   keywordHit=P0|P1             -> "P0" / "P1"
 *   urgent-kw=<word>             -> "<word>"
 */
function reasonFragmentFor(detail: string | undefined): string {
  if (!detail) return 'urgent';
  if (detail.startsWith('bucket=')) {
    const bucket = detail.slice('bucket='.length);
    switch (bucket) {
      case 'cancellation_request':
        return 'annulering';
      case 'refund_request':
        return 'refund';
      case 'partner_issue':
        return 'partner-issue';
      default:
        return bucket;
    }
  }
  if (detail.startsWith('flags=')) {
    const first = detail.slice('flags='.length).split(',')[0];
    switch (first) {
      case 'legal_threat':
        return 'juridisch';
      case 'chargeback':
        return 'chargeback';
      case 'sob_story_money':
        return 'financieel';
      default:
        return first;
    }
  }
  if (detail.startsWith('keywordHit=')) {
    return detail.slice('keywordHit='.length);
  }
  if (detail.startsWith('urgent-kw=')) {
    return detail.slice('urgent-kw='.length);
  }
  return 'urgent';
}

/**
 * Build the concise #team message for an interrupt-worthy batch.
 *
 * Dennis 2026-05-23 third iteration: NO bucket breakdowns, NO
 * "(N HIGH, M manual-only)" signal-parts, NO per-mail listings. A
 * #team mailbox post is ONE owner-tagged ACTION line that names the
 * urgency-reason(s) briefly so Jeanne can decide what to read first.
 *
 * Bundling: multiple urgent mails get one post with comma-separated
 * unique reasons (max 3, then "+N meer"). Non-urgent mails in the
 * batch are silently excluded; their reasons land in the suppressed-
 * counts state for the rollup.
 *
 * If no mail in the batch is interrupt-worthy, returns "" and the
 * caller MUST NOT post. Defence-in-depth alongside the runner's
 * shouldSuppressBatch gate (see runner.ts).
 */
export function buildDigestMessage(mails: ProcessedMail[], _now: Date = new Date()): string {
  if (mails.length === 0) {
    return '';
  }

  // Only consider interrupt-worthy mails. Non-urgent mails in a
  // mixed batch must not influence the urgency line.
  const urgent: { mail: ProcessedMail; reason: string }[] = [];
  for (const m of mails) {
    const d = classifyInterrupt(m);
    if (d.interrupt) {
      urgent.push({ mail: m, reason: reasonFragmentFor(d.detail) });
    }
  }

  if (urgent.length === 0) {
    return '';
  }

  // Dedup reasons, preserve first-seen order, cap at 3, append "+N meer"
  // if more distinct reasons exist.
  const seen = new Set<string>();
  const uniqueReasons: string[] = [];
  for (const u of urgent) {
    if (seen.has(u.reason)) continue;
    seen.add(u.reason);
    uniqueReasons.push(u.reason);
  }
  const shown = uniqueReasons.slice(0, 3);
  const extra = uniqueReasons.length - shown.length;
  const reasonStr = extra > 0 ? `${shown.join(', ')} +${extra} meer` : shown.join(', ');

  const count = urgent.length;
  const mailWord = count === 1 ? 'urgente klantmail' : `${count} urgente klantmails`;
  return `<@${JEANNE_SLACK_UID}> ACTION: behandel ${mailWord}: ${reasonStr}.`;
}
