import { describe, expect, it } from 'vitest';
import type { ProcessedMail } from '../types.js';
import { isAllLowPriority, isLowSuppressible } from './priority-gate.js';

function mkMail(overrides: Partial<ProcessedMail> = {}): ProcessedMail {
  return {
    uid: 1,
    fromHash: 'h1',
    maskedFrom: 'masked',
    maskedSubject: 'subj',
    maskedBody: 'body',
    manualOnly: false,
    date: new Date('2026-05-22T10:00:00Z'),
    bucket: 'booking_question',
    confidence: 0.9,
    flags: [],
    priority: 'NORMAL',
    keywordHit: null,
    ...overrides,
  };
}

describe('priority-gate', () => {
  describe('isLowSuppressible', () => {
    it('plain NORMAL booking_question with no flags is suppressible', () => {
      expect(isLowSuppressible(mkMail())).toBe(true);
    });

    it('HIGH priority is never suppressible', () => {
      expect(isLowSuppressible(mkMail({ priority: 'HIGH' }))).toBe(false);
    });

    it('manipulation-flag mail is never suppressible (priority would be HIGH anyway)', () => {
      expect(
        isLowSuppressible(mkMail({ priority: 'HIGH', flags: ['chargeback'] })),
      ).toBe(false);
    });

    it('keyword-hit mail is never suppressible', () => {
      expect(
        isLowSuppressible(
          mkMail({
            priority: 'HIGH',
            keywordHit: { severity: 'P0', keywords: ['kan niet betalen'], runbook: 'rb' },
          }),
        ),
      ).toBe(false);
    });

    it('manual-only mail (PII-redacted) is never suppressible', () => {
      expect(isLowSuppressible(mkMail({ manualOnly: true }))).toBe(false);
    });

    it('belt-and-braces: NORMAL but flags non-empty is not suppressible', () => {
      expect(
        isLowSuppressible(mkMail({ priority: 'NORMAL', flags: ['repeated_mailer'] })),
      ).toBe(false);
    });
  });

  describe('isAllLowPriority', () => {
    it('empty batch returns false (zero-mail branch handles that separately)', () => {
      expect(isAllLowPriority([])).toBe(false);
    });

    it('all-LOW batch returns true', () => {
      expect(isAllLowPriority([mkMail(), mkMail({ uid: 2 })])).toBe(true);
    });

    it('mixed batch with one HIGH returns false', () => {
      expect(
        isAllLowPriority([mkMail(), mkMail({ uid: 2, priority: 'HIGH' })]),
      ).toBe(false);
    });

    it('all-LOW with various low-info buckets returns true', () => {
      expect(
        isAllLowPriority([
          mkMail({ bucket: 'booking_question' }),
          mkMail({ uid: 2, bucket: 'general_info' }),
        ]),
      ).toBe(true);
    });

    it('cancellation_request is NEVER suppressible (customer-impact)', () => {
      expect(isLowSuppressible(mkMail({ bucket: 'cancellation_request' }))).toBe(false);
    });

    it('refund_request is NEVER suppressible (money-impact)', () => {
      expect(isLowSuppressible(mkMail({ bucket: 'refund_request' }))).toBe(false);
    });

    it('partner_issue is NEVER suppressible (internal escalation)', () => {
      expect(isLowSuppressible(mkMail({ bucket: 'partner_issue' }))).toBe(false);
    });

    it('needs_human_review is NEVER suppressible (classifier uncertain)', () => {
      expect(isLowSuppressible(mkMail({ bucket: 'needs_human_review' }))).toBe(false);
    });

    it('mixed batch with one cancellation_request returns false', () => {
      expect(
        isAllLowPriority([
          mkMail({ bucket: 'booking_question' }),
          mkMail({ uid: 2, bucket: 'cancellation_request' }),
        ]),
      ).toBe(false);
    });
  });
});
