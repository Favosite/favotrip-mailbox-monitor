/**
 * Phase-3 integration spec (Dennis 2026-05-21).
 *
 * Asserts that processMails() runs the existing 6-bucket classifier AND
 * the new keyword classifier in parallel, with the keyword hit attached
 * to ProcessedMail.keywordHit and the 6-bucket classification unchanged.
 *
 * Fixtures cover all four Dennis-listed P0/P1 classes plus a no-hit
 * baseline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { processMails } from './pipeline.js';
import { RepeatedMailerStore } from './classifier/repeated-mailer.service.js';
import type { RawMail } from './types.js';

let dir: string;
let store: RepeatedMailerStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-int-'));
  store = new RepeatedMailerStore({
    filePath: path.join(dir, 'h.json'),
    salt: 'integration-test-salt',
    thresholdCount: 3,
    windowDays: 7,
  });
  await store.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function mkRaw(over: Partial<RawMail> = {}): RawMail {
  return {
    uid: 1,
    fromAddress: 'klant@example.com',
    fromName: 'Klant Test',
    toAddress: 'klantenservice@favotrip.nl',
    subject: '',
    body: '',
    date: new Date('2026-05-21T13:00:00Z'),
    ...over,
  };
}

describe('pipeline.integration: keyword classifier + 6-bucket co-exist', () => {
  it('P0 payment_blocked: "kan niet betalen" attaches keywordHit AND keeps refund bucket', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 10,
          subject: 'Refund verzoek',
          body: 'Ik kan niet betalen, en ik wil mijn geld terug.',
        }),
      ],
      store,
    );
    expect(out).toHaveLength(1);
    const m = out[0];
    // Keyword classifier output
    expect(m.keywordHit).not.toBeNull();
    expect(m.keywordHit!.severity).toBe('P0');
    expect(m.keywordHit!.keywords).toContain('kan niet betalen');
    // 6-bucket classifier output unaffected
    expect(m.bucket).toBe('refund_request');
    // Priority escalated to HIGH because of the keyword hit
    expect(m.priority).toBe('HIGH');
  });

  it('P0 stripe error: keywordHit set + 6-bucket still classifies', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 11,
          subject: 'Stripe error tijdens boeking',
          body: 'Bij het boeken kreeg ik een stripe error en kon niet doorgaan.',
        }),
      ],
      store,
    );
    expect(out[0].keywordHit!.severity).toBe('P0');
    expect(out[0].keywordHit!.keywords).toContain('stripe error');
  });

  it('P0 iDEAL: matches "iDEAL werkt niet"', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 12,
          subject: 'iDEAL probleem',
          body: 'iDEAL werkt niet bij het afrekenen.',
        }),
      ],
      store,
    );
    expect(out[0].keywordHit!.severity).toBe('P0');
  });

  it('P1 voucher_unusable: "voucher werkt niet" attaches keywordHit', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 20,
          subject: 'Voucher probleem',
          body: 'Mijn voucher werkt niet, hij wordt steeds afgewezen.',
        }),
      ],
      store,
    );
    expect(out[0].keywordHit!.severity).toBe('P1');
    expect(out[0].keywordHit!.keywords).toContain('voucher werkt niet');
    expect(out[0].priority).toBe('HIGH');
  });

  it('P1 price_drift: "duurder" attaches keywordHit', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 21,
          subject: 'Prijs vraag',
          body: 'De prijs is duurder geworden sinds vanochtend, hoe kan dat?',
        }),
      ],
      store,
    );
    expect(out[0].keywordHit!.severity).toBe('P1');
  });

  it('P1 no_availability: "geen beschikbaarheid" attaches keywordHit', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 22,
          subject: 'Beschikbaarheid',
          body: 'Er is geen beschikbaarheid op mijn gewenste datum.',
        }),
      ],
      store,
    );
    expect(out[0].keywordHit!.severity).toBe('P1');
  });

  it('no-hit baseline: regular booking question gets no keywordHit', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 30,
          subject: 'Vraag over voucher',
          body: 'Hoe kan ik mijn voucher verzilveren? Mijn boeking is FT-AB-CD-EF.',
          reservationCode: 'FT-AB-CD-EF',
        }),
      ],
      store,
    );
    expect(out[0].keywordHit).toBeNull();
    expect(out[0].bucket).toBe('booking_question');
    expect(out[0].priority).toBe('NORMAL');
  });

  it('mixed batch: each mail independently classified', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 40,
          fromAddress: 'a@example.com',
          subject: 'P0',
          body: 'kan niet betalen',
        }),
        mkRaw({
          uid: 41,
          fromAddress: 'b@example.com',
          subject: 'P1',
          body: 'voucher werkt niet',
        }),
        mkRaw({
          uid: 42,
          fromAddress: 'c@example.com',
          subject: 'no-hit',
          body: 'Wat zijn jullie openingstijden?',
        }),
      ],
      store,
    );
    expect(out[0].keywordHit?.severity).toBe('P0');
    expect(out[1].keywordHit?.severity).toBe('P1');
    expect(out[2].keywordHit).toBeNull();
  });

  it('keyword classifier does NOT disturb manualOnly redaction for IBAN mails', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 50,
          subject: 'Refund',
          body: 'Mijn IBAN NL91ABNA0417164300, ik kan niet betalen, refund alstublieft.',
        }),
      ],
      store,
    );
    // Body redacted by PII-mask (IBAN trigger)
    expect(out[0].manualOnly).toBe(true);
    expect(out[0].maskedBody).not.toContain('NL91ABNA0417164300');
    // But keyword classifier ran on the RAW body so it still caught
    // "kan niet betalen"
    expect(out[0].keywordHit?.severity).toBe('P0');
  });

  it('priority bump only — does NOT add a manipulation flag', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 60,
          subject: 'Probleem',
          body: 'iDEAL werkt niet bij mij.',
        }),
      ],
      store,
    );
    expect(out[0].priority).toBe('HIGH');
    expect(out[0].flags).toHaveLength(0); // no sob_story / legal_threat / chargeback / repeated_mailer
    expect(out[0].keywordHit?.severity).toBe('P0');
  });
});
