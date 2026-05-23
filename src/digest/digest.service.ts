import type { Bucket, DigestStats, ProcessedMail } from '../types.js';

/**
 * Slack user-ID for Jeanne (klantenservice lead). Used as the owner-tag
 * in actionable #team posts so per CLAUDE.md 5-point doctrine line 1 is
 * `<@U07TM7DKMUF> ACTION: …`. Mirrors server-claude-worker constants.
 */
export const JEANNE_SLACK_UID = 'U07TM7DKMUF';

// Kept for legacy consumers of BUCKET_DISPLAY via re-export; the new
// formatter does NOT render bucket labels top-level in #team (Dennis
// 2026-05-23 spec). Re-import from daily-rollup.service.ts if you need
// it for structured-log payloads.
const _BUCKET_DISPLAY_LEGACY: Record<Bucket, string> = {
  booking_question: 'booking_question',
  cancellation_request: 'cancellation_request',
  refund_request: 'refund_request',
  partner_issue: 'partner_issue',
  general_info: 'general_info',
  spam_out_of_scope: 'spam_out_of_scope',
  needs_human_review: 'needs_human_review',
};
void _BUCKET_DISPLAY_LEGACY;

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
 * Build the concise #team message for an interrupt-worthy batch.
 *
 * Dennis 2026-05-23 rollup-formatting spec: #team must NOT receive
 * bucket-counts breakdowns, per-mail listings, or "Klantenservice
 * digest" header rollups. The only #team posts allowed are owner-tagged
 * ACTION lines with a single follow-up reason line. Detail (per-mail
 * bucket / flags / confidence) lives in the structured log + state
 * file; this formatter never re-renders it for #team.
 *
 * The runner is responsible for only calling this when at least one
 * mail in the batch is interrupt-worthy (see interrupt-policy.ts).
 * If the runner calls with an empty array, the function returns an
 * empty string and the caller MUST suppress the post — no zero-mail
 * heartbeat. Dropping that line was Dennis's explicit ask.
 */
export function buildDigestMessage(mails: ProcessedMail[], _now: Date = new Date()): string {
  if (mails.length === 0) {
    // Caller MUST treat empty string as "do not post". Dropping the
    // zero-mail heartbeat — kept only as a structured log line by the
    // runner — is part of the 2026-05-23 spec ("Geen actie nodig").
    return '';
  }

  const stats = buildStats(mails);

  // Single concise summary line so Jeanne sees the count + the urgent
  // signal mix without the full per-mail dump. Order in the parenthesis
  // matches operator-priority: HIGH first, then manual-only, then total.
  const signalParts: string[] = [];
  if (stats.highPriorityCount > 0) {
    signalParts.push(`${stats.highPriorityCount} HIGH`);
  }
  if (stats.manualOnlyCount > 0) {
    signalParts.push(`${stats.manualOnlyCount} manual-only`);
  }
  const signal = signalParts.length > 0 ? ` (${signalParts.join(', ')})` : '';

  const mailWord = stats.total === 1 ? 'klantmail' : 'klantmails';
  const verb = stats.total === 1 ? 'wacht' : 'wachten';

  return (
    `<@${JEANNE_SLACK_UID}> ACTION: behandel ${stats.total} ${mailWord}` +
    ` handmatig in klantenservice@favotrip.nl.\n` +
    `${stats.total} ${mailWord}${signal} ${verb} op review.`
  );
}
