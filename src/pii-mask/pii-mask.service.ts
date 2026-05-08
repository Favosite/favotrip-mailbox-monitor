import {
  CARD_RE,
  EMAIL_RE,
  IBAN_RE,
  MEDICAL_RE,
  NAME_RE,
  PHONE_RE,
  RESERVATION_CODE_RE,
} from './patterns.js';

export interface MaskResult {
  masked: string;
  manualOnly: boolean;
  triggers: string[];
}

const MANUAL_ONLY_BODY = '[REDACTED — manual-only: contains sensitive financial or medical content]';

function maskEmails(input: string): string {
  return input.replace(EMAIL_RE, (m) => {
    const [, domain] = m.split('@');
    return '***@' + (domain ?? 'redacted');
  });
}

function maskNames(input: string): string {
  return input.replace(NAME_RE, '<naam-gemaskeerd>');
}

function maskPhones(input: string): string {
  return input.replace(PHONE_RE, '***');
}

function preserveReservationCodes(input: string): { protected: string; placeholders: string[] } {
  const placeholders: string[] = [];
  const protectedText = input.replace(RESERVATION_CODE_RE, (m) => {
    placeholders.push(m);
    return `__RESCODE_${placeholders.length - 1}__`;
  });
  return { protected: protectedText, placeholders };
}

function restoreReservationCodes(input: string, placeholders: string[]): string {
  return input.replace(/__RESCODE_(\d+)__/g, (_, idx) => placeholders[Number(idx)] ?? '');
}

export function maskBody(body: string): MaskResult {
  const triggers: string[] = [];

  if (IBAN_RE.test(body)) triggers.push('IBAN');
  IBAN_RE.lastIndex = 0;

  if (CARD_RE.test(body)) triggers.push('CARD');
  CARD_RE.lastIndex = 0;

  if (MEDICAL_RE.test(body)) triggers.push('MEDICAL');

  if (triggers.length > 0) {
    return { masked: MANUAL_ONLY_BODY, manualOnly: true, triggers };
  }

  const { protected: protectedBody, placeholders } = preserveReservationCodes(body);

  let result = protectedBody;
  result = maskEmails(result);
  result = maskPhones(result);
  result = maskNames(result);
  result = restoreReservationCodes(result, placeholders);

  return { masked: result, manualOnly: false, triggers: [] };
}

export function maskSubject(subject: string): string {
  const { protected: protectedSubject, placeholders } = preserveReservationCodes(subject);
  let result = protectedSubject;
  result = maskEmails(result);
  result = maskPhones(result);
  result = maskNames(result);
  return restoreReservationCodes(result, placeholders);
}

export function maskFromHeader(rawFrom: string): string {
  let result = maskEmails(rawFrom);
  result = maskNames(result);
  return result;
}
