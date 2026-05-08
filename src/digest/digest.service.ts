import type { Bucket, DigestStats, ProcessedMail } from '../types.js';

const BUCKET_DISPLAY: Record<Bucket, string> = {
  booking_question: 'booking_question',
  cancellation_request: 'cancellation_request',
  refund_request: 'refund_request',
  partner_issue: 'partner_issue',
  general_info: 'general_info',
  spam_out_of_scope: 'spam_out_of_scope',
  needs_human_review: 'needs_human_review',
};

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

export function buildDigestMessage(mails: ProcessedMail[], now: Date = new Date()): string {
  const stats = buildStats(mails);
  const ts = formatCEST(now);

  if (stats.total === 0) {
    return `:zzz: Klantenservice digest — ${ts}: 0 mails since last digest.`;
  }

  const lines: string[] = [];
  lines.push(`:mailbox_with_mail: *Klantenservice digest — ${ts}*`);
  lines.push(`${stats.total} mail${stats.total === 1 ? '' : 's'} since last digest. Bucket counts:`);

  const sortedBuckets = Object.entries(stats.byBucket).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  for (const [bucket, count] of sortedBuckets) {
    const highInBucket = mails.filter((m) => m.bucket === bucket && m.priority === 'HIGH').length;
    const flagSuffix = highInBucket > 0 ? `  :triangular_flag_on_post: ${highInBucket}× priority:HIGH` : '';
    lines.push(`• ${count} ${BUCKET_DISPLAY[bucket as Bucket]}${flagSuffix}`);
  }
  if (stats.manualOnlyCount > 0) {
    lines.push(`• ${stats.manualOnlyCount} manual-only (PII redacted)`);
  }

  lines.push('');

  for (const m of mails) {
    const reservation = m.reservationCode ? ` ${m.reservationCode}` : '';
    const flagPrefix = m.priority === 'HIGH' ? ':triangular_flag_on_post: HIGH ' : '';
    const conf = m.bucket === 'needs_human_review' ? '—' : `${Math.round(m.confidence * 100)}%`;
    const flagsStr = m.flags.length > 0 ? `  (${m.flags.join('+')})` : '';
    const time = formatCEST(m.date);
    const bucketLabel = m.manualOnly ? 'manual-only' : BUCKET_DISPLAY[m.bucket];
    lines.push(`— ${flagPrefix}${bucketLabel.padEnd(20)} conf=${conf}${reservation}  · ${time}${flagsStr}`);
  }

  return lines.join('\n');
}

function formatCEST(d: Date): string {
  // Slack messages get a single time, not ISO. Keep CEST display per spec.
  const formatter = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Amsterdam',
    hour12: false,
  });
  return `${formatter.format(d)} CEST`;
}
