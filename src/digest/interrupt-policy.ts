import type { Bucket, ManipulationFlag, ProcessedMail } from '../types.js';

/**
 * Interrupt-policy gate, supersedes the simpler isAllLowPriority gate for
 * the #team digest poster.
 *
 * Dennis 2026-05-23 third iteration (manual-only / needs_human_review spam):
 *   Even after PR #11/#13, #team still received single-mail posts like
 *   "ACTION: behandel 1 klantmail handmatig" at 20:30 + 21:15 driven by
 *   `manualOnly=true` without any real urgency. Manual-only is a
 *   routing signal (PII-redacted, human-eyes required) but it is NOT
 *   inherently urgent: a customer asking for help configuring a deal
 *   gets manualOnly=true with zero time-pressure. Posting one of those
 *   immediately top-level in #team is noise, not signal.
 *
 *   NEW: manualOnly is removed from interrupt-triggers. It still
 *   classifies the mail as `manual_only_nonurgent` for the rollup so
 *   nothing is lost; it just doesn't escalate to #team unless something
 *   else (urgent bucket, urgent keyword, P0/P1, urgent flag) co-occurs.
 *
 * Interrupt-worthy when ANY of:
 *   - bucket in {cancellation_request, refund_request, partner_issue}
 *     (always time-sensitive / money-impact)
 *   - any flag in INTERRUPT_FLAGS (legal_threat, chargeback,
 *     sob_story_money), content-urgent, NOT including repeated_mailer
 *   - keywordHit present (P0/P1 from the keyword classifier)
 *   - URGENT_KEYWORDS substring match in masked subject or body
 *     (covers "betaalmodule", "voucher werkt niet", "geld terug", etc.)
 *
 * Suppressed (to the 09:00 rollup) when ALL of the above are false. The
 * suppression reason is captured per-mail for the rollup so operators
 * can see WHY mail was suppressed, not just that it was.
 *
 * Suppress-reason codes (mutually exclusive, evaluated in order):
 *   repeated_mailer_only         flags == ['repeated_mailer'] and nothing else
 *   manual_only_nonurgent        manualOnly=true without urgent co-signal
 *   needs_human_review_nonurgent bucket=='needs_human_review' without urgent kw
 *   low_priority                 original LOW-bucket NORMAL-priority case
 *   other_routine                fallback (rare; covers edge cases)
 *
 * The interrupt-policy is on top of the existing #alerts keyword pipeline
 * and queue-task dispatcher, both of which remain unaffected. Only the
 * #team digest poster decision is gated.
 */

/**
 * Urgent keywords. Substring-match (case-insensitive) against the masked
 * subject and masked body. Matched terms are short and customer-typical;
 * we deliberately avoid English / formal-Dutch synonyms that would broaden
 * the match too much.
 */
export const URGENT_KEYWORDS: readonly string[] = [
  'betaalmodule',
  'betaling lukt niet',
  'kan niet betalen',
  'voucher werkt niet',
  'code werkt niet',
  'checkout',
  'refund',
  'annulering',
  'klacht',
  'geld terug',
  'dubbel betaald',
];

/**
 * Buckets that always trigger immediate #team posting regardless of
 * priority or flags. Customer-impact / money-impact / partner escalation.
 */
export const INTERRUPT_BUCKETS: ReadonlySet<Bucket> = new Set<Bucket>([
  'cancellation_request',
  'refund_request',
  'partner_issue',
]);

/**
 * Manipulation flags that signal genuine content urgency. Critically
 * EXCLUDES `repeated_mailer` (volume-only, not content-urgent).
 */
export const INTERRUPT_FLAGS: ReadonlySet<ManipulationFlag> = new Set<ManipulationFlag>([
  'legal_threat',
  'chargeback',
  'sob_story_money',
]);

export type SuppressReason =
  | 'low_priority'
  | 'repeated_mailer_only'
  | 'manual_only_nonurgent'
  | 'needs_human_review_nonurgent'
  | 'other_routine';

export interface InterruptDecision {
  /** True when this mail should drive an immediate #team digest post. */
  interrupt: boolean;
  /** Reason code — 'interrupt' when interrupt=true; a SuppressReason otherwise. */
  reason: SuppressReason | 'interrupt';
  /** Human-readable detail for logging only. Never used for policy decisions. */
  detail?: string;
}

/**
 * Case-insensitive substring search across URGENT_KEYWORDS. Returns the
 * first matched keyword or null.
 */
export function findUrgentKeyword(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const kw of URGENT_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

/**
 * Classify a single mail as interrupt-worthy or routine-suppressed,
 * capturing the reason for downstream logging/rollup.
 *
 * Pure function. No I/O. Deterministic per ProcessedMail content.
 */
export function classifyInterrupt(m: ProcessedMail): InterruptDecision {
  // 1. Time-sensitive / money-impact buckets always interrupt.
  if (INTERRUPT_BUCKETS.has(m.bucket)) {
    return { interrupt: true, reason: 'interrupt', detail: `bucket=${m.bucket}` };
  }

  // 2. Content-urgent manipulation flags interrupt.
  //    `repeated_mailer` is deliberately not in INTERRUPT_FLAGS.
  const realFlags = m.flags.filter((f) => INTERRUPT_FLAGS.has(f));
  if (realFlags.length > 0) {
    return { interrupt: true, reason: 'interrupt', detail: `flags=${realFlags.join(',')}` };
  }

  // 3. P0/P1 keyword-classifier hit interrupts.
  if (m.keywordHit) {
    return { interrupt: true, reason: 'interrupt', detail: `keywordHit=${m.keywordHit.severity}` };
  }

  // 4. URGENT_KEYWORDS substring in subject or body interrupts.
  //    Note: manualOnly removed from interrupt-triggers per Dennis
  //    2026-05-23 spec. It now classifies as `manual_only_nonurgent`
  //    in the suppression block below.
  const subjectHit = findUrgentKeyword(m.maskedSubject);
  const bodyHit = subjectHit ? null : findUrgentKeyword(m.maskedBody);
  if (subjectHit || bodyHit) {
    return {
      interrupt: true,
      reason: 'interrupt',
      detail: `urgent-kw=${subjectHit ?? bodyHit ?? '?'}`,
    };
  }

  // Not interrupt-worthy. Classify the suppression reason for the rollup.

  // Reason order matters. repeated_mailer_only is more specific than the
  // bucket-based reasons and should fire first when it's the only flag.
  const onlyRepeatedMailer =
    m.flags.length > 0 && m.flags.every((f) => f === 'repeated_mailer');
  if (onlyRepeatedMailer) {
    return { interrupt: false, reason: 'repeated_mailer_only' };
  }

  // Manual-only without urgent co-signal. Per Dennis 2026-05-23 this
  // is the most common false-interrupt source so it gets a dedicated
  // reason ahead of needs_human_review_nonurgent.
  if (m.manualOnly) {
    return { interrupt: false, reason: 'manual_only_nonurgent' };
  }

  if (m.bucket === 'needs_human_review') {
    return { interrupt: false, reason: 'needs_human_review_nonurgent' };
  }

  // Pre-this-PR LOW classification (NORMAL + low-information bucket).
  const LOW_BUCKETS: ReadonlySet<Bucket> = new Set<Bucket>([
    'booking_question',
    'general_info',
    'spam_out_of_scope',
  ]);
  if (
    LOW_BUCKETS.has(m.bucket) &&
    m.priority === 'NORMAL' &&
    m.flags.length === 0
  ) {
    return { interrupt: false, reason: 'low_priority' };
  }

  return { interrupt: false, reason: 'other_routine' };
}

/**
 * True when every mail in the batch is routine (no mail is
 * interrupt-worthy). Empty batches return false so the existing zero-mail
 * rate-limit path stays the single source of truth for "0 mails".
 */
export function isAllRoutine(mails: ProcessedMail[]): boolean {
  if (mails.length === 0) return false;
  return mails.every((m) => !classifyInterrupt(m).interrupt);
}

/**
 * Per-mail classification with reason attached. Useful for the runner
 * when feeding the SuppressedCountsStore.
 */
export interface ClassifiedMail {
  mail: ProcessedMail;
  reason: SuppressReason;
}

export function classifyForSuppression(mails: ProcessedMail[]): ClassifiedMail[] {
  const out: ClassifiedMail[] = [];
  for (const m of mails) {
    const d = classifyInterrupt(m);
    if (!d.interrupt) {
      out.push({ mail: m, reason: d.reason as SuppressReason });
    }
  }
  return out;
}
