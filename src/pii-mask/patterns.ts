// Order in maskBody matters: most-specific first.
// Email regex is permissive — must run BEFORE name regex so "John Doe <a@b.com>" doesn't lose the email.
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// IBAN: ISO 13616 — 2 letters + 2 digits + up to 30 alphanum, with NL-special-case.
// We accept any country to be safe (klantenservice could see DE/BE/FR IBANs too).
export const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

// Card numbers: 13-19 digit groups separated by space/dash. Match common 16-digit pattern explicitly.
export const CARD_RE = /\b(?:\d{4}[ -]?){3}\d{1,4}\b|\b\d{13,19}\b/g;

// Phones: catches NL mobile (06xxxxxxxx), NL landline with separators, and INTL +CCC...
// Pattern: optional +, then digit, then 7-18 chars of digit/space/dash, ending in digit.
// Minimum 9 digits total — short enough to keep false-positives low (random year-month-day strings
// like 2026-05-08 are 8 chars total; would fail the min-9-digit floor).
export const PHONE_RE = /\+?\d(?:[\s-]?\d){8,18}/g;

// 13-19 raw digits — defensive catch for IBAN-look-alikes / account numbers / customer-IDs that might be sensitive.
// Run AFTER card so we don't double-trigger.
export const BIG_NUM_RE = /\b\d{13,19}\b/g;

// Names: "FirstName [tussenvoegsels] LastName" — both parts capitalized. Tussenvoegsels (van/de/der
// etc.) are optional and may appear zero or more times between the two capitalized parts.
// Run AFTER email + IBAN so domain TLDs aren't accidentally masked.
export const NAME_RE =
  /\b[A-Z][a-zà-ÿ]{1,}(?:\s+(?:van|de|der|den|ter|ten|te|von|di|du))*\s+[A-Z][a-zà-ÿ]{1,}\b/g;

// Medical allowlist. NL-focused, lowercase compare. Extend on operator feedback.
export const MEDICAL_TERMS = [
  'ziekenhuis',
  'ziek ',
  'medisch',
  'medische',
  'diagnose',
  'operatie',
  'huisarts',
  'oncoloog',
  'chemo',
  'kanker',
  'overlijden',
  'overleden',
  'palliatief',
  'spoedeisende hulp',
];

export const MEDICAL_RE = new RegExp(
  '\\b(' + MEDICAL_TERMS.map((t) => t.trim().replace(/\s+/g, '\\s+')).join('|') + ')\\b',
  'i',
);

// Reservation code pattern Favotrip uses: FT-XX-YY-ZZ (uppercase or mixed). Keep these visible — they are non-PII operator IDs.
export const RESERVATION_CODE_RE = /\bFT-[A-Z0-9]{2,4}(?:-[A-Z0-9]{2,4}){1,3}\b/g;
