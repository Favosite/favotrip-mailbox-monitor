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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-'));
  store = new RepeatedMailerStore({
    filePath: path.join(dir, 'h.json'),
    salt: 'test',
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
    fromAddress: 'jan.jansen@example.com',
    fromName: 'Jan Jansen',
    toAddress: 'klantenservice@favotrip.nl',
    subject: 'Vraag over voucher',
    body: 'Hoi, hoe kan ik mijn voucher verzilveren? Mijn boeking is FT-AB-CD-EF.',
    date: new Date('2026-05-08T12:00:00Z'),
    reservationCode: 'FT-AB-CD-EF',
    ...over,
  };
}

describe('pipeline.processMails', () => {
  it('masks From header and body, classifies, returns 1 mail', () => {
    const out = processMails([mkRaw()], store);
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.maskedFrom).toContain('***@example.com');
    expect(m.maskedFrom).toContain('<naam-gemaskeerd>');
    expect(m.maskedFrom).not.toContain('jan.jansen');
    expect(m.bucket).toBe('booking_question');
    expect(m.priority).toBe('NORMAL');
    expect(m.manualOnly).toBe(false);
    expect(m.reservationCode).toBe('FT-AB-CD-EF');
  });

  it('marks IBAN body as manual-only', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 2,
          subject: 'Refund',
          body: 'IBAN NL91ABNA0417164300, ik wil mijn geld terug.',
        }),
      ],
      store,
    );
    expect(out[0].manualOnly).toBe(true);
    expect(out[0].maskedBody).not.toContain('NL91ABNA0417164300');
  });

  it('flags HIGH priority for sob-story refund', () => {
    const out = processMails(
      [
        mkRaw({
          uid: 3,
          subject: 'URGENT refund',
          body: 'Mijn moeder is ziek, ik wil mijn geld terug, anders schakel ik mijn advocaat in.',
        }),
      ],
      store,
    );
    expect(out[0].priority).toBe('HIGH');
    expect(out[0].flags).toContain('sob_story_money');
    expect(out[0].flags).toContain('legal_threat');
  });

  it('flags repeated_mailer when same address has 3+ sightings', () => {
    const m = mkRaw({ fromAddress: 'spammer@example.com', fromName: undefined });
    processMails([{ ...m, uid: 10 }], store);
    processMails([{ ...m, uid: 11 }], store);
    const out = processMails([{ ...m, uid: 12 }], store);
    expect(out[0].flags).toContain('repeated_mailer');
    expect(out[0].priority).toBe('HIGH');
  });
});
