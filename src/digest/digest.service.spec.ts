import { describe, expect, it } from 'vitest';
import { JEANNE_SLACK_UID, buildDigestMessage, buildStats } from './digest.service.js';
import type { ProcessedMail } from '../types.js';

function mkMail(over: Partial<ProcessedMail> = {}): ProcessedMail {
  return {
    uid: 1,
    fromHash: 'h0',
    maskedFrom: '***@example.com',
    maskedSubject: 'masked subject',
    maskedBody: 'masked body',
    manualOnly: false,
    date: new Date('2026-05-08T13:00:00Z'),
    bucket: 'booking_question',
    confidence: 0.8,
    flags: [],
    priority: 'NORMAL',
    ...over,
  };
}

describe('buildStats', () => {
  it('counts buckets and high-priority + manual-only', () => {
    const mails: ProcessedMail[] = [
      mkMail({ bucket: 'booking_question' }),
      mkMail({ bucket: 'booking_question' }),
      mkMail({ bucket: 'refund_request', priority: 'HIGH', flags: ['sob_story_money'] }),
      mkMail({ bucket: 'cancellation_request', manualOnly: true }),
    ];
    const s = buildStats(mails);
    expect(s.total).toBe(4);
    expect(s.byBucket.booking_question).toBe(2);
    expect(s.byBucket.refund_request).toBe(1);
    expect(s.byBucket.cancellation_request).toBe(1);
    expect(s.highPriorityCount).toBe(1);
    expect(s.manualOnlyCount).toBe(1);
  });
});

describe('buildDigestMessage — 2026-05-23 rollup-formatting spec (Dennis)', () => {
  it('zero-mail returns empty string (caller MUST suppress)', () => {
    const out = buildDigestMessage([], new Date('2026-05-08T13:00:00Z'));
    expect(out).toBe('');
  });

  it('actionable batch produces one concise owner-tagged ACTION line with reasons', () => {
    const mails: ProcessedMail[] = [
      mkMail({ bucket: 'cancellation_request', confidence: 0.95 }),
      mkMail({
        bucket: 'refund_request',
        confidence: 0.81,
        priority: 'HIGH',
        flags: ['sob_story_money', 'legal_threat'],
      }),
    ];
    const out = buildDigestMessage(mails, new Date('2026-05-08T13:00:00Z'));
    // Single-line ACTION post, no per-mail or bucket breakdown.
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toMatch(
      new RegExp(`^<@${JEANNE_SLACK_UID}> ACTION: behandel 2 urgente klantmails: `),
    );
    expect(out).toContain('annulering');
    expect(out).toContain('refund');
    expect(out).toMatch(/\.$/);
  });

  it('single urgent mail uses singular form + single reason', () => {
    const out = buildDigestMessage(
      [mkMail({ bucket: 'cancellation_request' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    expect(out).toBe(
      `<@${JEANNE_SLACK_UID}> ACTION: behandel urgente klantmail: annulering.`,
    );
  });

  it('manual-only WITHOUT urgent co-signal produces NO #team post', () => {
    const out = buildDigestMessage(
      [mkMail({ manualOnly: true, maskedBody: '[REDACTED]' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    expect(out).toBe('');
  });

  it('needs_human_review WITHOUT urgent keyword produces NO #team post', () => {
    const out = buildDigestMessage(
      [mkMail({ bucket: 'needs_human_review' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    expect(out).toBe('');
  });

  it('repeated_mailer flag alone produces NO #team post', () => {
    const out = buildDigestMessage(
      [mkMail({ flags: ['repeated_mailer'], priority: 'HIGH' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    expect(out).toBe('');
  });

  it('urgent keyword "voucher werkt niet" produces short ACTION post', () => {
    const out = buildDigestMessage(
      [mkMail({ bucket: 'booking_question', maskedBody: 'mijn voucher werkt niet' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    expect(out).toBe(
      `<@${JEANNE_SLACK_UID}> ACTION: behandel urgente klantmail: voucher werkt niet.`,
    );
  });

  it('urgent keyword "betaalmodule" produces short ACTION post', () => {
    const out = buildDigestMessage(
      [mkMail({ bucket: 'booking_question', maskedBody: 'betaalmodule doet het niet' })],
      new Date(),
    );
    expect(out).toContain('ACTION: behandel urgente klantmail: betaalmodule.');
  });

  it('NO bucket-counts breakdown, NO `(N HIGH, M manual-only)` signal parts', () => {
    const mails: ProcessedMail[] = [
      mkMail({ bucket: 'booking_question' }),
      mkMail({ bucket: 'refund_request', priority: 'HIGH' }),
      mkMail({ bucket: 'cancellation_request' }),
      mkMail({ bucket: 'partner_issue' }),
    ];
    const out = buildDigestMessage(mails, new Date('2026-05-08T13:00:00Z'));
    for (const banned of [
      'booking_question',
      'general_info',
      'spam_out_of_scope',
      'needs_human_review',
      'HIGH',
      'manual-only',
      'klantenservice@favotrip.nl',
      'wacht op review',
    ]) {
      expect(out).not.toContain(banned);
    }
    expect(out).not.toContain('Klantenservice digest');
    expect(out).not.toMatch(/conf=\d+%/);
    expect(out).not.toMatch(/CEST/);
  });

  it('owner tag is the canonical Jeanne UID + ACTION-prefix on line 1', () => {
    const out = buildDigestMessage(
      [mkMail({ bucket: 'cancellation_request' })],
      new Date(),
    );
    expect(out.startsWith(`<@${JEANNE_SLACK_UID}> ACTION:`)).toBe(true);
  });

  it('NO `_Technical refs:_` footer in #team payload', () => {
    const out = buildDigestMessage(
      [mkMail({ priority: 'HIGH', flags: ['legal_threat'] })],
      new Date(),
    );
    expect(out).not.toContain('_Technical refs');
  });

  it('dedupes identical reasons across multiple mails (3 cancellations = one reason fragment)', () => {
    const out = buildDigestMessage(
      [
        mkMail({ bucket: 'cancellation_request' }),
        mkMail({ bucket: 'cancellation_request' }),
        mkMail({ bucket: 'cancellation_request' }),
      ],
      new Date(),
    );
    // Count of unique reason fragment should be 1; total count says 3.
    expect(out).toContain('3 urgente klantmails');
    expect(out).toContain('annulering');
    // Should NOT repeat "annulering" three times in the reason list.
    expect((out.match(/annulering/g) ?? []).length).toBe(1);
  });

  it('caps shown reasons at 3 and appends "+N meer" for additional unique reasons', () => {
    const out = buildDigestMessage(
      [
        mkMail({ bucket: 'cancellation_request' }),
        mkMail({ bucket: 'refund_request' }),
        mkMail({ bucket: 'partner_issue' }),
        mkMail({ priority: 'HIGH', flags: ['legal_threat'] }),
      ],
      new Date(),
    );
    expect(out).toContain('+1 meer');
  });
});
