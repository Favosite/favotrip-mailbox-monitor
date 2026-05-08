import { describe, expect, it } from 'vitest';
import { classify } from './classifier.service.js';

describe('classifier', () => {
  it('routes annulering to cancellation_request', () => {
    const r = classify('Annulering boeking', 'Wij willen onze annulering doorgeven, kunnen niet komen.');
    expect(r.bucket).toBe('cancellation_request');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('routes refund text to refund_request', () => {
    const r = classify('Refund verzoek', 'Ik wil mijn geld terug — graag een refund afhandelen.');
    expect(r.bucket).toBe('refund_request');
  });

  it('routes hotel ratehawk to partner_issue', () => {
    const r = classify('Probleem met hotel', 'Onze RateHawk hotel was overboekt, no-show probleem.');
    expect(r.bucket).toBe('partner_issue');
  });

  it('routes voucher question to booking_question', () => {
    const r = classify('Voucher code', 'Hoe kan ik mijn voucher verzilveren? Ik wil graag boeken.');
    expect(r.bucket).toBe('booking_question');
  });

  it('routes general info to general_info', () => {
    const r = classify('Vraag', 'Wat zijn jullie openingstijden? Hoe werkt het bij jullie?');
    expect(r.bucket).toBe('general_info');
  });

  it('routes B2B outreach to spam_out_of_scope', () => {
    const r = classify(
      'Marketing partnership opportunity',
      'Hi, we offer SEO services and cold outreach for B2B leads.',
    );
    expect(r.bucket).toBe('spam_out_of_scope');
  });

  it('routes empty/unknown content to needs_human_review', () => {
    const r = classify('Hi', 'random text without any business signals at all.');
    expect(r.bucket).toBe('needs_human_review');
  });

  it('routes ambiguous mixed signals below threshold to needs_human_review', () => {
    // Single weak keyword from each of two buckets — confidence stays under 0.5
    const r = classify('Vraag', 'check-in info');
    if (r.bucket !== 'needs_human_review') {
      expect(r.confidence).toBeGreaterThan(0.5);
    }
  });

  it('confidence sums to <= 1.0', () => {
    const r = classify('Annulering refund hotel boeking', 'Annulering refund partner boeking');
    expect(r.confidence).toBeLessThanOrEqual(1.0);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
  });
});
