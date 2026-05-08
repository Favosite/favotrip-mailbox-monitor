import { describe, expect, it } from 'vitest';
import { maskBody, maskFromHeader, maskSubject } from './pii-mask.service.js';

describe('PII mask — body', () => {
  it('redacts NL IBAN to manual-only', () => {
    const r = maskBody('Mijn IBAN is NL91ABNA0417164300 voor de refund.');
    expect(r.manualOnly).toBe(true);
    expect(r.triggers).toContain('IBAN');
    expect(r.masked).not.toContain('NL91ABNA0417164300');
    expect(r.masked).not.toContain('Mijn IBAN');
  });

  it('redacts non-NL IBAN (DE)', () => {
    const r = maskBody('IBAN: DE89370400440532013000 graag overmaken.');
    expect(r.manualOnly).toBe(true);
    expect(r.masked).not.toContain('DE89370400440532013000');
  });

  it('redacts 16-digit card with spaces to manual-only', () => {
    const r = maskBody('Card 4111 1111 1111 1111 charged twice');
    expect(r.manualOnly).toBe(true);
    expect(r.triggers).toContain('CARD');
    expect(r.masked).not.toContain('4111');
  });

  it('redacts 16-digit card with dashes', () => {
    const r = maskBody('5500-0000-0000-0004 used for booking');
    expect(r.manualOnly).toBe(true);
    expect(r.masked).not.toContain('5500');
  });

  it('redacts contiguous 16-digit number to manual-only', () => {
    const r = maskBody('Kaart: 4111111111111111 charged');
    expect(r.manualOnly).toBe(true);
    expect(r.masked).not.toContain('4111111111111111');
  });

  it('redacts medical content to manual-only', () => {
    const r = maskBody('Mijn moeder is in het ziekenhuis opgenomen.');
    expect(r.manualOnly).toBe(true);
    expect(r.triggers).toContain('MEDICAL');
    expect(r.masked).not.toContain('ziekenhuis');
  });

  it('detects medical "operatie"', () => {
    const r = maskBody('Wij hebben een operatie gepland.');
    expect(r.manualOnly).toBe(true);
  });

  it('masks email addresses (keeps domain)', () => {
    const r = maskBody('Contact me at john.doe@example.com please.');
    expect(r.manualOnly).toBe(false);
    expect(r.masked).toContain('***@example.com');
    expect(r.masked).not.toContain('john.doe');
  });

  it('masks NL mobile phone number', () => {
    const r = maskBody('Bel me op 0612345678 vandaag');
    expect(r.manualOnly).toBe(false);
    expect(r.masked).not.toContain('0612345678');
    expect(r.masked).toContain('***');
  });

  it('masks international phone number', () => {
    const r = maskBody('Call +31 20 123 4567 for support');
    expect(r.masked).not.toContain('+31 20 123 4567');
  });

  it('masks first-last name pattern', () => {
    const r = maskBody('Met vriendelijke groet, Jan Jansen');
    expect(r.masked).toContain('<naam-gemaskeerd>');
    expect(r.masked).not.toContain('Jan Jansen');
  });

  it('masks Dutch tussenvoegsel names', () => {
    const r = maskBody('Bestelling van Pieter van der Berg.');
    expect(r.masked).toContain('<naam-gemaskeerd>');
    expect(r.masked).not.toContain('Pieter van der Berg');
  });

  it('preserves reservation codes', () => {
    const r = maskBody('Ik wil mijn boeking FT-AB-CD-EF wijzigen.');
    expect(r.masked).toContain('FT-AB-CD-EF');
  });

  it('combined PII — IBAN takes priority over names', () => {
    const r = maskBody('Beste Jan Jansen, IBAN: NL91ABNA0417164300');
    expect(r.manualOnly).toBe(true);
    expect(r.masked).not.toContain('Jan Jansen');
    expect(r.masked).not.toContain('NL91');
  });

  it('benign body — no PII triggers', () => {
    const r = maskBody('Wat zijn de openingstijden van uw klantenservice?');
    expect(r.manualOnly).toBe(false);
    expect(r.triggers).toEqual([]);
  });
});

describe('PII mask — subject', () => {
  it('masks email in subject', () => {
    const out = maskSubject('Re: betaling van john@example.com');
    expect(out).toContain('***@example.com');
  });

  it('preserves reservation codes in subject', () => {
    const out = maskSubject('Vraag over FT-XX-YY-ZZ');
    expect(out).toContain('FT-XX-YY-ZZ');
  });

  it('masks names in subject', () => {
    const out = maskSubject('Klacht van Jan Jansen');
    expect(out).toContain('<naam-gemaskeerd>');
    expect(out).not.toContain('Jan Jansen');
  });
});

describe('PII mask — From header', () => {
  it('masks both display name and address', () => {
    const out = maskFromHeader('Jan Jansen <jan@example.com>');
    expect(out).toContain('<naam-gemaskeerd>');
    expect(out).toContain('***@example.com');
    expect(out).not.toContain('jan@example.com');
  });

  it('masks address-only From', () => {
    const out = maskFromHeader('jan.de.boer@example.com');
    expect(out).toContain('***@example.com');
  });
});
