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

  it('actionable batch produces concise owner-tagged 2-line message', () => {
    const mails: ProcessedMail[] = [
      mkMail({ bucket: 'cancellation_request', confidence: 0.95, reservationCode: 'FT-PP-QQ-RR' }),
      mkMail({
        bucket: 'refund_request',
        confidence: 0.81,
        priority: 'HIGH',
        flags: ['sob_story_money', 'legal_threat'],
        reservationCode: 'FT-MM-NN-OO',
      }),
    ];
    const out = buildDigestMessage(mails, new Date('2026-05-08T13:00:00Z'));
    const lines = out.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(
      `<@${JEANNE_SLACK_UID}> ACTION: behandel 2 klantmails handmatig in klantenservice@favotrip.nl.`,
    );
    expect(lines[1]).toContain('2 klantmails');
    expect(lines[1]).toContain('1 HIGH');
  });

  it('single-mail batch is singular (klantmail, wacht)', () => {
    const out = buildDigestMessage(
      [mkMail({ manualOnly: true, maskedBody: '[REDACTED]' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    const lines = out.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(
      `<@${JEANNE_SLACK_UID}> ACTION: behandel 1 klantmail handmatig in klantenservice@favotrip.nl.`,
    );
    expect(lines[1]).toContain('1 klantmail');
    expect(lines[1]).toContain('1 manual-only');
    expect(lines[1]).toContain('wacht op review.');
  });

  it('NO bucket-counts breakdown ever leaks into #team body', () => {
    const mails: ProcessedMail[] = [
      mkMail({ bucket: 'booking_question' }),
      mkMail({ bucket: 'refund_request', priority: 'HIGH' }),
      mkMail({ bucket: 'cancellation_request' }),
      mkMail({ bucket: 'partner_issue' }),
    ];
    const out = buildDigestMessage(mails, new Date('2026-05-08T13:00:00Z'));
    // Bucket names from the breakdown must not appear top-level.
    expect(out).not.toMatch(/Bucket counts/i);
    for (const banned of [
      'booking_question',
      'refund_request',
      'cancellation_request',
      'partner_issue',
      'general_info',
      'spam_out_of_scope',
      'needs_human_review',
    ]) {
      expect(out).not.toContain(banned);
    }
    // No "Klantenservice digest — HH:MM CEST" header.
    expect(out).not.toContain('Klantenservice digest');
    // No per-mail listing (legacy `— <bucket>  conf=…` lines).
    expect(out).not.toMatch(/conf=\d+%/);
    expect(out).not.toMatch(/conf=—/);
    expect(out).not.toMatch(/CEST/);
  });

  it('owner tag on line 1 is the canonical Jeanne UID + ACTION-prefix', () => {
    const out = buildDigestMessage([mkMail({ manualOnly: true })], new Date());
    const line1 = out.split('\n')[0];
    expect(line1.startsWith(`<@${JEANNE_SLACK_UID}> ACTION:`)).toBe(true);
  });

  it('NO `_Technical refs:_` footer in #team payload', () => {
    const out = buildDigestMessage(
      [mkMail({ priority: 'HIGH', flags: ['legal_threat'] })],
      new Date(),
    );
    expect(out).not.toContain('_Technical refs');
  });
});
