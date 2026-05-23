import { describe, expect, it } from 'vitest';
import type { Bucket, ManipulationFlag, ProcessedMail } from '../types.js';
import {
  INTERRUPT_BUCKETS,
  INTERRUPT_FLAGS,
  URGENT_KEYWORDS,
  classifyForSuppression,
  classifyInterrupt,
  findUrgentKeyword,
  isAllRoutine,
} from './interrupt-policy.js';

/** Test factory — every field defaults to a routine LOW state. */
function mkMail(overrides: Partial<ProcessedMail> = {}): ProcessedMail {
  return {
    uid: 1,
    fromHash: 'h1',
    maskedFrom: 'masked-from',
    maskedSubject: 'subj',
    maskedBody: 'body',
    manualOnly: false,
    date: new Date('2026-05-22T14:00:00Z'),
    bucket: 'booking_question',
    confidence: 0.9,
    flags: [],
    priority: 'NORMAL',
    keywordHit: null,
    ...overrides,
  };
}

describe('URGENT_KEYWORDS / findUrgentKeyword', () => {
  it('matches case-insensitive substrings', () => {
    expect(findUrgentKeyword('Mijn BETAALMODULE is stuk')).toBe('betaalmodule');
    expect(findUrgentKeyword('GELD TERUG aub')).toBe('geld terug');
  });

  it('returns null for non-matching text', () => {
    expect(findUrgentKeyword('Wanneer is mijn boeking?')).toBe(null);
  });

  it('handles null / empty / undefined safely', () => {
    expect(findUrgentKeyword(null)).toBe(null);
    expect(findUrgentKeyword(undefined)).toBe(null);
    expect(findUrgentKeyword('')).toBe(null);
  });

  it('covers every URGENT_KEYWORDS entry', () => {
    for (const kw of URGENT_KEYWORDS) {
      expect(findUrgentKeyword(`prefix ${kw} suffix`)).toBe(kw);
    }
  });
});

describe('classifyInterrupt — interrupt-worthy cases', () => {
  for (const bucket of ['cancellation_request', 'refund_request', 'partner_issue'] as Bucket[]) {
    it(`bucket=${bucket} always interrupts`, () => {
      const d = classifyInterrupt(mkMail({ bucket }));
      expect(d.interrupt).toBe(true);
      expect(d.reason).toBe('interrupt');
      expect(d.detail).toContain(bucket);
    });
  }

  for (const flag of ['legal_threat', 'chargeback', 'sob_story_money'] as ManipulationFlag[]) {
    it(`flag=${flag} interrupts (HIGH priority because of real flag)`, () => {
      const d = classifyInterrupt(mkMail({ flags: [flag], priority: 'HIGH' }));
      expect(d.interrupt).toBe(true);
      expect(d.reason).toBe('interrupt');
      expect(d.detail).toContain(flag);
    });
  }

  it('P0 keyword hit interrupts', () => {
    const d = classifyInterrupt(
      mkMail({
        priority: 'HIGH',
        keywordHit: { severity: 'P0', keywords: ['kan niet betalen'], runbook: 'rb' },
      }),
    );
    expect(d.interrupt).toBe(true);
    expect(d.detail).toContain('P0');
  });

  it('manualOnly WITHOUT urgent co-signal does NOT interrupt (Dennis 2026-05-23 third iteration)', () => {
    const d = classifyInterrupt(mkMail({ manualOnly: true }));
    expect(d.interrupt).toBe(false);
    expect(d.reason).toBe('manual_only_nonurgent');
  });

  it('manualOnly WITH urgent keyword DOES interrupt (urgent kw wins, not manualOnly)', () => {
    const d = classifyInterrupt(
      mkMail({ manualOnly: true, maskedBody: 'mijn voucher werkt niet' }),
    );
    expect(d.interrupt).toBe(true);
    expect(d.detail).toContain('urgent-kw=voucher werkt niet');
  });

  it('manualOnly WITH refund_request bucket DOES interrupt (bucket wins)', () => {
    const d = classifyInterrupt(mkMail({ manualOnly: true, bucket: 'refund_request' }));
    expect(d.interrupt).toBe(true);
    expect(d.detail).toBe('bucket=refund_request');
  });

  it('urgent keyword in subject interrupts', () => {
    const d = classifyInterrupt(mkMail({ maskedSubject: 'mijn betaalmodule werkt niet' }));
    expect(d.interrupt).toBe(true);
    expect(d.detail).toContain('urgent-kw=betaalmodule');
  });

  it('urgent keyword in body interrupts even when subject is benign', () => {
    const d = classifyInterrupt(
      mkMail({ maskedSubject: 'vraag', maskedBody: 'help mijn voucher werkt niet' }),
    );
    expect(d.interrupt).toBe(true);
    expect(d.detail).toContain('voucher werkt niet');
  });
});

describe('classifyInterrupt — routine-suppressed cases (NEW behaviour)', () => {
  it('booking_question LOW is suppressed as low_priority', () => {
    const d = classifyInterrupt(mkMail({ bucket: 'booking_question', priority: 'NORMAL' }));
    expect(d.interrupt).toBe(false);
    expect(d.reason).toBe('low_priority');
  });

  it('booking_question HIGH driven ONLY by repeated_mailer is suppressed as repeated_mailer_only', () => {
    const d = classifyInterrupt(
      mkMail({ bucket: 'booking_question', priority: 'HIGH', flags: ['repeated_mailer'] }),
    );
    expect(d.interrupt).toBe(false);
    expect(d.reason).toBe('repeated_mailer_only');
  });

  it('needs_human_review without urgent keyword is suppressed as needs_human_review_nonurgent (NEW)', () => {
    const d = classifyInterrupt(
      mkMail({ bucket: 'needs_human_review', priority: 'NORMAL', flags: [] }),
    );
    expect(d.interrupt).toBe(false);
    expect(d.reason).toBe('needs_human_review_nonurgent');
  });

  it('needs_human_review HIGH driven ONLY by repeated_mailer is suppressed as repeated_mailer_only (NEW)', () => {
    const d = classifyInterrupt(
      mkMail({ bucket: 'needs_human_review', priority: 'HIGH', flags: ['repeated_mailer'] }),
    );
    expect(d.interrupt).toBe(false);
    // repeated_mailer_only takes precedence over needs_human_review_nonurgent
    expect(d.reason).toBe('repeated_mailer_only');
  });

  it('needs_human_review with urgent keyword interrupts (NEW)', () => {
    const d = classifyInterrupt(
      mkMail({
        bucket: 'needs_human_review',
        priority: 'NORMAL',
        maskedBody: 'betaling lukt niet',
      }),
    );
    expect(d.interrupt).toBe(true);
    expect(d.detail).toContain('betaling lukt niet');
  });

  it('booking_question with urgent keyword "voucher werkt niet" interrupts (NEW)', () => {
    const d = classifyInterrupt(
      mkMail({
        bucket: 'booking_question',
        priority: 'NORMAL',
        maskedBody: 'mijn voucher werkt niet meer sinds gisteren',
      }),
    );
    expect(d.interrupt).toBe(true);
    expect(d.detail).toContain('voucher werkt niet');
  });
});

describe('isAllRoutine', () => {
  it('empty batch returns false (zero-mail branch handles that)', () => {
    expect(isAllRoutine([])).toBe(false);
  });

  it('all-routine batch returns true', () => {
    expect(
      isAllRoutine([
        mkMail({ bucket: 'booking_question' }),
        mkMail({ uid: 2, bucket: 'booking_question', flags: ['repeated_mailer'], priority: 'HIGH' }),
        mkMail({ uid: 3, bucket: 'needs_human_review' }),
      ]),
    ).toBe(true);
  });

  it('mixed batch with one cancellation_request returns false', () => {
    expect(
      isAllRoutine([
        mkMail({ bucket: 'booking_question' }),
        mkMail({ uid: 2, bucket: 'cancellation_request' }),
      ]),
    ).toBe(false);
  });

  it('mixed batch with one mail containing urgent keyword returns false', () => {
    expect(
      isAllRoutine([
        mkMail({ uid: 1, bucket: 'booking_question' }),
        mkMail({ uid: 2, bucket: 'booking_question', maskedSubject: 'klacht over voucher' }),
      ]),
    ).toBe(false);
  });
});

describe('classifyForSuppression', () => {
  it('returns only the routine mails with their reason codes attached', () => {
    const mails = [
      mkMail({ uid: 1, bucket: 'booking_question' }), // low_priority
      mkMail({ uid: 2, bucket: 'cancellation_request' }), // INTERRUPT — excluded
      mkMail({ uid: 3, bucket: 'needs_human_review' }), // needs_human_review_nonurgent
      mkMail({ uid: 4, flags: ['repeated_mailer'], priority: 'HIGH' }), // repeated_mailer_only
    ];
    const result = classifyForSuppression(mails);
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.reason).sort()).toEqual([
      'low_priority',
      'needs_human_review_nonurgent',
      'repeated_mailer_only',
    ]);
    // Excludes the cancellation_request (interrupt-worthy)
    expect(result.find((c) => c.mail.bucket === 'cancellation_request')).toBeUndefined();
  });

  it('returns empty array when every mail is interrupt-worthy', () => {
    const mails = [
      mkMail({ uid: 1, bucket: 'cancellation_request' }),
      mkMail({ uid: 2, flags: ['legal_threat'], priority: 'HIGH' }),
    ];
    expect(classifyForSuppression(mails)).toEqual([]);
  });

  it('manual_only_nonurgent surfaces in classifyForSuppression output (2026-05-23)', () => {
    const mails = [
      mkMail({ uid: 1, manualOnly: true }), // manual_only_nonurgent
      mkMail({ uid: 2, manualOnly: true, bucket: 'refund_request' }), // INTERRUPT
      mkMail({ uid: 3, manualOnly: true, bucket: 'needs_human_review' }), // manual_only_nonurgent
    ];
    const result = classifyForSuppression(mails);
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.reason === 'manual_only_nonurgent')).toBe(true);
  });
});

describe('constants are well-formed', () => {
  it('INTERRUPT_FLAGS excludes repeated_mailer (smoke)', () => {
    expect(INTERRUPT_FLAGS.has('repeated_mailer')).toBe(false);
  });

  it('INTERRUPT_BUCKETS contains the 3 customer-impact buckets', () => {
    expect(INTERRUPT_BUCKETS.has('cancellation_request')).toBe(true);
    expect(INTERRUPT_BUCKETS.has('refund_request')).toBe(true);
    expect(INTERRUPT_BUCKETS.has('partner_issue')).toBe(true);
  });
});
