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

  it('actionable batch produces one concise owner-tagged ACTION line with reasons (2026-05-26: urgency comes from keyword/flag, not bucket)', () => {
    const mails: ProcessedMail[] = [
      // bucket alone no longer interrupts — these get urgency from P0 keywords / flags
      mkMail({ bucket: 'cancellation_request', confidence: 0.95, maskedBody: 'klacht' }),
      mkMail({
        bucket: 'refund_request',
        confidence: 0.81,
        priority: 'HIGH',
        flags: ['legal_threat'], // single flag → reason 'juridisch'
      }),
    ];
    const out = buildDigestMessage(mails, new Date('2026-05-08T13:00:00Z'));
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toMatch(
      new RegExp(`^<@${JEANNE_SLACK_UID}> ACTION: behandel 2 urgente klantmails: `),
    );
    // Reasons come from the urgency-triggering signals: kw=klacht + flag=legal_threat ("juridisch")
    expect(out).toContain('klacht');
    expect(out).toContain('juridisch');
    expect(out).toMatch(/\.$/);
  });

  it('single urgent mail uses singular form + single reason (urgency via P0 keyword)', () => {
    const out = buildDigestMessage(
      [mkMail({ bucket: 'cancellation_request', maskedBody: 'kan niet boeken' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    expect(out).toBe(
      `<@${JEANNE_SLACK_UID}> ACTION: behandel urgente klantmail: kan niet boeken.`,
    );
  });

  it('routine cancellation_request WITHOUT urgent keyword produces NO #team post (2026-05-26: routes to daily rollup)', () => {
    const out = buildDigestMessage(
      [mkMail({ bucket: 'cancellation_request', maskedBody: 'graag annulering doorgeven van mijn boeking' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    expect(out).toBe('');
  });

  it('routine partner_issue WITHOUT urgent keyword produces NO #team post', () => {
    const out = buildDigestMessage(
      [mkMail({ bucket: 'partner_issue', maskedBody: 'wachten op partner reactie' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    expect(out).toBe('');
  });

  it('routine refund_request WITHOUT urgent keyword produces NO #team post', () => {
    const out = buildDigestMessage(
      [mkMail({ bucket: 'refund_request', maskedBody: 'graag terugbetaling regelen' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    expect(out).toBe('');
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

  it('owner tag is the canonical Jeanne UID + ACTION-prefix on line 1 (urgency via P0 keyword)', () => {
    const out = buildDigestMessage(
      [mkMail({ bucket: 'cancellation_request', maskedBody: 'kan niet boeken' })],
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

  it('dedupes identical reasons across multiple mails (3 P0 keyword hits = one reason fragment)', () => {
    const out = buildDigestMessage(
      [
        mkMail({ uid: 1, bucket: 'cancellation_request', maskedBody: 'kan niet boeken' }),
        mkMail({ uid: 2, bucket: 'cancellation_request', maskedBody: 'kan niet boeken' }),
        mkMail({ uid: 3, bucket: 'cancellation_request', maskedBody: 'kan niet boeken' }),
      ],
      new Date(),
    );
    // Count of unique reason fragment should be 1; total count says 3.
    expect(out).toContain('3 urgente klantmails');
    expect(out).toContain('kan niet boeken');
    // Should NOT repeat the reason three times in the reason list.
    expect((out.match(/kan niet boeken/g) ?? []).length).toBe(1);
  });

  it('caps shown reasons at 3 and appends "+N meer" for additional unique reasons', () => {
    // 4 mails with 4 distinct urgency reasons (now that buckets alone don't interrupt,
    // each mail needs its own keyword/flag co-signal).
    const out = buildDigestMessage(
      [
        mkMail({ uid: 1, bucket: 'cancellation_request', maskedBody: 'kan niet boeken' }), // → "kan niet boeken"
        mkMail({ uid: 2, bucket: 'refund_request', maskedBody: 'geld terug nu' }),         // → "geld terug"
        mkMail({ uid: 3, bucket: 'partner_issue', maskedBody: 'klacht over partner' }),    // → "klacht"
        mkMail({ uid: 4, priority: 'HIGH', flags: ['legal_threat'] }),                     // → "juridisch"
      ],
      new Date(),
    );
    expect(out).toContain('+1 meer');
  });
});
