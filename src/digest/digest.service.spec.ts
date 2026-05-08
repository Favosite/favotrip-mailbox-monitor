import { describe, expect, it } from 'vitest';
import { buildDigestMessage, buildStats } from './digest.service.js';
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

describe('buildDigestMessage', () => {
  it('zero-mail digest is one line', () => {
    const out = buildDigestMessage([], new Date('2026-05-08T13:00:00Z'));
    expect(out).toContain(':zzz:');
    expect(out).toContain('0 mails since last digest');
    expect(out.split('\n').length).toBe(1);
  });

  it('multi-mail digest contains bucket counts and per-mail lines', () => {
    const mails: ProcessedMail[] = [
      mkMail({ bucket: 'booking_question', confidence: 0.89, reservationCode: 'FT-AB-CD-EF' }),
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
    expect(out).toContain('Klantenservice digest');
    expect(out).toContain('booking_question');
    expect(out).toContain('cancellation_request');
    expect(out).toContain('refund_request');
    expect(out).toContain('priority:HIGH');
    expect(out).toContain('FT-AB-CD-EF');
    expect(out).toContain('FT-MM-NN-OO');
    expect(out).toContain('HIGH');
    expect(out).toContain('sob_story_money+legal_threat');
  });

  it('shows manual-only count when present', () => {
    const out = buildDigestMessage(
      [mkMail({ manualOnly: true, maskedBody: '[REDACTED]' })],
      new Date('2026-05-08T13:00:00Z'),
    );
    expect(out).toContain('manual-only');
  });
});
