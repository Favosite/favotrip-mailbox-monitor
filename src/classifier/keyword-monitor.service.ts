/**
 * Keyword classifier (Phase 3, Dennis 2026-05-21).
 *
 * Runs IN ADDITION to the existing 6-bucket classifier. Matches a fixed
 * list of customer-complaint keywords against subject + body and emits a
 * severity tag (P0 = customer cannot pay / money-blocking; P1 = customer
 * cannot book / voucher unusable / pricing complaint).
 *
 * Output routes to #alerts (NOT #team) as a structured Slack post; the
 * existing 6-bucket digest is unaffected.
 *
 * Match-rules:
 *   - Case-insensitive (lowercase both haystack + needle).
 *   - Accent-insensitive via NFD-normalize + strip combining marks. So
 *     "duurder" matches "duurder" with any NL diacritics, "Klarna" with
 *     accents, etc.
 *   - Word-boundary friendly so "stripe" doesn't match URLs like
 *     "stripe.com". We strip URLs from the haystack BEFORE matching, and
 *     enforce a word boundary on single-token keywords. Multi-word
 *     keywords (e.g. "kan niet betalen") are matched as a substring since
 *     they cannot collide with a URL token.
 *   - Multi-language: includes English equivalents in P0 set per spec.
 *
 * If multiple keywords hit, classify at the HIGHEST severity level seen
 * (P0 wins over P1).
 */

export type KeywordSeverity = 'P0' | 'P1';

export interface KeywordHit {
  severity: KeywordSeverity;
  keywords: string[];
  runbook: string;
}

export interface KeywordSpec {
  severity: KeywordSeverity;
  /** Display-form keyword (also the dedupe label). */
  phrase: string;
  /** Runbook hint group this keyword belongs to. */
  runbookKey: RunbookKey;
}

type RunbookKey =
  | 'payment_blocked'
  | 'voucher_unusable'
  | 'price_drift'
  | 'no_availability';

const RUNBOOKS: Record<RunbookKey, string> = {
  payment_blocked:
    "Check `payment_intents` for customer's reservation (status patterns). If stuck-checkout-monitor already alerted on this resv, this is the customer-confirmation half. Reach out with manual payment link.",
  voucher_unusable:
    "Run validateVoucher on the voucher_code from customer mail (visible after PR site-backend#813's reason+refId is deployed). Determine if INACTIVE/LOCKED/EXPIRED. Reach out with explanation.",
  price_drift:
    'Check `reservation` + `payment_intents` for retry-attempt history. Likely cross-attempt price drift (Daniela-class). stuck-checkout-monitor catches the symptom; this is the verbal confirmation.',
  no_availability:
    'Frontend dead-end OR genuine REAL_OUT_OF_STOCK. Cross-reference `booking_error_events`.',
};

/**
 * Severity-priority order (highest first) so that when multiple keywords
 * hit we keep the *most severe* runbook for the top-of-message hint.
 */
const SEVERITY_RANK: Record<KeywordSeverity, number> = { P0: 2, P1: 1 };

export const KEYWORD_SPECS: KeywordSpec[] = [
  // ── P0: payment-blocking ────────────────────────────────────────────
  { severity: 'P0', phrase: 'kan niet betalen', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'kan niet afrekenen', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'betaling kan niet voorbereid', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'payment failed', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'stripe error', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'klarna failed', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'creditcard werkt niet', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'creditcard geweigerd', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'ideal werkt niet', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'ideal gefaald', runbookKey: 'payment_blocked' },
  // English equivalents (spec: "include English equivalents in P0 set")
  { severity: 'P0', phrase: "can't pay", runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'cannot pay', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: "couldn't pay", runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'could not pay', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'unable to pay', runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: "can't checkout", runbookKey: 'payment_blocked' },
  { severity: 'P0', phrase: 'cannot checkout', runbookKey: 'payment_blocked' },

  // ── P1: book/voucher/price ──────────────────────────────────────────
  { severity: 'P1', phrase: 'voucher werkt niet', runbookKey: 'voucher_unusable' },
  { severity: 'P1', phrase: 'voucher inactive', runbookKey: 'voucher_unusable' },
  { severity: 'P1', phrase: 'voucher locked', runbookKey: 'voucher_unusable' },
  { severity: 'P1', phrase: 'prijs veranderd', runbookKey: 'price_drift' },
  { severity: 'P1', phrase: 'duurder', runbookKey: 'price_drift' },
  { severity: 'P1', phrase: 'prijs is hoger', runbookKey: 'price_drift' },
  { severity: 'P1', phrase: 'geen beschikbaarheid', runbookKey: 'no_availability' },
];

/**
 * Known B2B partner sender domains.
 *
 * The keyword runbooks all assume the sender is a Favotrip CUSTOMER
 * ("customer cannot pay / book / voucher unusable"). Partner backoffices
 * reply on internal Wijzigingsverzoek / voucher-block threads using the
 * SAME vocabulary ("geen beschikbaarheid", "prijs veranderd", "voucher
 * blokkeren") about the partner's own order ids, which fires a
 * customer-impact P0/P1 #alerts page that is a false positive. The order
 * number in a partner subject is the PARTNER's identifier, not a Favotrip
 * reservation_id (max ~2142) / reservation_number (FT-XX-XX-XX).
 *
 * Partner correspondence is already handled by the 6-bucket classifier
 * (partner_issue bucket) and lands in Jeanne's inbox via the reply chain,
 * so suppressing the keyword page for these senders loses no signal.
 *
 * Match is on the registrable domain SUFFIX so subdomains
 * (mail.ratehawk.com) and backoffice mailers (backoffice@crossover.nl)
 * are covered.
 */
export const PARTNER_SENDER_DOMAINS: readonly string[] = [
  'crossover.nl', // Backoffice ING (externally-sold ING voucher fulfilment)
  'phl-tickets.eu', // Phantasialand
  'ratehawk.com',
  'viator.com',
  'musement.com',
];

/**
 * True when `fromAddress` belongs to a known B2B partner domain. Empty /
 * malformed addresses return false (treat as customer -> do not suppress).
 */
export function isPartnerSender(fromAddress: string | undefined): boolean {
  if (!fromAddress) return false;
  const at = fromAddress.lastIndexOf('@');
  if (at === -1) return false;
  const domain = fromAddress.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  return PARTNER_SENDER_DOMAINS.some(
    (p) => domain === p || domain.endsWith('.' + p),
  );
}

/**
 * Strip diacritics so `duurder` matches `duurder` with NL combining
 * marks, and so accented Latin variants of "Klärna"/"Stripé" etc. still
 * match. NFD-decomposes then drops combining marks.
 */
function stripAccents(s: string): string {
  // \p{M} matches Unicode combining marks; after NFD decomposition the
  // combining diacritics become standalone codepoints we can drop.
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|nl|de|be|fr|co\.uk|io|app|net|org|eu)(?:\/\S*)?/gi;

/**
 * HTML-strip helper for callers that have an HTML body. Returns plain
 * text suitable for matching. Conservative: drops tags + decodes a few
 * common entities. Mail bodies generally already have a `.text` plaintext
 * variant via simpleParser, so this is mainly defensive when the caller
 * only has HTML.
 */
export function stripHtml(html: string): string {
  return html
    // Block-level closes become newlines (preserve sentence boundaries).
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Inline tags drop without adding whitespace so "vriend</b>." stays
    // "vriend.".
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

function normalize(s: string): string {
  return stripAccents(s.toLowerCase());
}

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[a-z0-9]/.test(ch);
}

/**
 * Does `needle` (already lowercased + accent-stripped) appear in
 * `haystack` (same treatment)?
 *
 * For SINGLE-token needles (no whitespace), we enforce word boundaries
 * on both sides so "stripe" doesn't match the URL fragment "stripe" in
 * "stripe.com". URLs are already pre-stripped from the haystack at the
 * caller, but this is the second line of defense.
 *
 * For MULTI-word needles ("kan niet betalen"), we use substring match
 * because the multi-word pattern cannot occur inside a single URL token.
 */
function hasPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const isMultiWord = /\s/.test(needle.trim());
  if (isMultiWord) {
    return haystack.includes(needle);
  }
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    const before = haystack[idx - 1];
    const after = haystack[idx + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }
    idx += 1;
  }
  return false;
}

/**
 * Match keywords against a parsed mail (subject + body, optionally HTML).
 * Returns null if no keyword matched. Returns the top-severity hit with
 * the union of all matched keywords (display-form) when at least one
 * keyword matched.
 */
export function classifyKeywords(input: {
  subject: string;
  body: string;
  html?: string;
  /**
   * Raw sender address. When it belongs to a known B2B partner domain the
   * customer-impact keyword runbooks do not apply, so we suppress the hit
   * (return null) rather than fire a false-positive #alerts page. Optional
   * so existing callers / tests keep working (undefined => not a partner).
   */
  fromAddress?: string;
}): KeywordHit | null {
  // 0. Partner-domain guard. Partner backoffices (ratehawk, viator,
  //    phl-tickets, crossover/ING) reply on internal threads using the
  //    same complaint vocabulary about THEIR order ids; classifying those
  //    as a customer P0/P1 is always a false positive (see
  //    project_mailbox_keyword_b2b_partner_fp). The 6-bucket classifier
  //    still routes them via the partner_issue bucket.
  if (isPartnerSender(input.fromAddress)) {
    return null;
  }

  // 1. Build the corpus: subject + body + optional HTML-stripped fallback
  //    (defensive — caller-provided html only used if body is empty).
  const bodyText = input.body && input.body.trim().length > 0
    ? input.body
    : (input.html ? stripHtml(input.html) : '');
  const corpusRaw = (input.subject ?? '') + '\n' + bodyText;

  // 2. Strip URLs from the corpus so "visit stripe.com for help" doesn't
  //    fire a Stripe-error match.
  const corpusNoUrls = corpusRaw.replace(URL_RE, ' ');

  // 3. Normalize (lowercase + accent-strip) once.
  const corpus = normalize(corpusNoUrls);

  // 4. Scan all specs.
  const matched: KeywordSpec[] = [];
  for (const spec of KEYWORD_SPECS) {
    const needle = normalize(spec.phrase);
    if (hasPhrase(corpus, needle)) {
      matched.push(spec);
    }
  }
  if (matched.length === 0) {
    return null;
  }

  // 5. Determine top severity (P0 > P1).
  let topSeverity: KeywordSeverity = matched[0].severity;
  for (const m of matched) {
    if (SEVERITY_RANK[m.severity] > SEVERITY_RANK[topSeverity]) {
      topSeverity = m.severity;
    }
  }

  // 6. Build the runbook for the top-severity grouping: pick the runbook
  //    of the FIRST top-severity match (stable, deterministic order from
  //    KEYWORD_SPECS).
  const topMatch = matched.find((m) => m.severity === topSeverity);
  const runbookKey: RunbookKey = topMatch ? topMatch.runbookKey : 'payment_blocked';

  // 7. Return union of display-form keywords matched (preserve insertion
  //    order, dedupe).
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const m of matched) {
    if (!seen.has(m.phrase)) {
      seen.add(m.phrase);
      keywords.push(m.phrase);
    }
  }

  return {
    severity: topSeverity,
    keywords,
    runbook: RUNBOOKS[runbookKey],
  };
}
