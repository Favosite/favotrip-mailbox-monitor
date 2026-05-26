import { describe, expect, it } from 'vitest';
import { classifyKeywords, isNonCustomerSender, stripHtml } from './keyword-monitor.service.js';

describe('classifyKeywords — P0 matches', () => {
  it('matches "kan niet betalen" as P0', () => {
    const r = classifyKeywords({ subject: 'Probleem', body: 'Ik kan niet betalen voor mijn boeking.' });
    expect(r).not.toBeNull();
    expect(r!.severity).toBe('P0');
    expect(r!.keywords).toContain('kan niet betalen');
  });

  it('matches "kan niet afrekenen" as P0', () => {
    const r = classifyKeywords({
      subject: '',
      body: 'Ik kan niet afrekenen op jullie site, geen idee waarom.',
    });
    expect(r!.severity).toBe('P0');
    expect(r!.keywords).toContain('kan niet afrekenen');
  });

  it('matches "betaling kan niet voorbereid" as P0', () => {
    const r = classifyKeywords({ subject: 'Foutmelding', body: 'De betaling kan niet voorbereid worden.' });
    expect(r!.severity).toBe('P0');
  });

  it('matches "payment failed" as P0 (English)', () => {
    const r = classifyKeywords({ subject: 'Payment failed', body: 'Hi, my payment failed twice today.' });
    expect(r!.severity).toBe('P0');
    expect(r!.keywords).toContain('payment failed');
  });

  it('matches "stripe error" as P0 (English)', () => {
    const r = classifyKeywords({ subject: 'Issue', body: 'I got a Stripe Error when paying.' });
    expect(r!.severity).toBe('P0');
  });

  it('matches "klarna failed" as P0', () => {
    const r = classifyKeywords({ subject: '', body: 'Klarna failed and I cannot finish my booking.' });
    expect(r!.severity).toBe('P0');
  });

  it('matches "creditcard werkt niet" as P0', () => {
    const r = classifyKeywords({ subject: 'Hulp', body: 'Mijn creditcard werkt niet bij jullie.' });
    expect(r!.severity).toBe('P0');
  });

  it('matches "creditcard geweigerd" as P0', () => {
    const r = classifyKeywords({ subject: '', body: 'De creditcard geweigerd melding bleef komen.' });
    expect(r!.severity).toBe('P0');
  });

  it('matches "iDEAL werkt niet" as P0', () => {
    const r = classifyKeywords({ subject: 'iDEAL probleem', body: 'iDEAL werkt niet bij het betalen.' });
    expect(r!.severity).toBe('P0');
  });

  it('matches "iDEAL gefaald" as P0', () => {
    const r = classifyKeywords({ subject: '', body: 'iDEAL gefaald — kan niet door met de boeking.' });
    expect(r!.severity).toBe('P0');
  });

  it("matches \"can't pay\" as P0 (English contraction)", () => {
    const r = classifyKeywords({ subject: '', body: "I can't pay through your website, please help." });
    expect(r!.severity).toBe('P0');
  });

  it('matches "cannot pay" as P0', () => {
    const r = classifyKeywords({ subject: '', body: 'I cannot pay, the form errors out.' });
    expect(r!.severity).toBe('P0');
  });
});

describe('classifyKeywords — P1 matches', () => {
  it('matches "voucher werkt niet" as P1', () => {
    const r = classifyKeywords({ subject: 'Voucher', body: 'Mijn voucher werkt niet als ik die invoer.' });
    expect(r!.severity).toBe('P1');
    expect(r!.keywords).toContain('voucher werkt niet');
  });

  it('matches "voucher inactive" as P1', () => {
    const r = classifyKeywords({ subject: '', body: 'The system says voucher inactive when I redeem.' });
    expect(r!.severity).toBe('P1');
  });

  it('matches "voucher locked" as P1', () => {
    const r = classifyKeywords({ subject: '', body: 'Voucher locked — what does that mean?' });
    expect(r!.severity).toBe('P1');
  });

  it('matches "prijs veranderd" as P1', () => {
    const r = classifyKeywords({ subject: '', body: 'De prijs veranderd na het inloggen, gek.' });
    expect(r!.severity).toBe('P1');
  });

  it('matches "duurder" as P1', () => {
    const r = classifyKeywords({ subject: '', body: 'Bij het afrekenen werd alles duurder.' });
    expect(r!.severity).toBe('P1');
  });

  it('matches "prijs is hoger" as P1', () => {
    const r = classifyKeywords({ subject: '', body: 'De prijs is hoger dan op de site stond.' });
    expect(r!.severity).toBe('P1');
  });

  it('matches "geen beschikbaarheid" as P1', () => {
    const r = classifyKeywords({ subject: '', body: 'Geen beschikbaarheid op de gewenste data.' });
    expect(r!.severity).toBe('P1');
  });
});

describe('classifyKeywords — match-rules', () => {
  it('is case-insensitive', () => {
    const r = classifyKeywords({ subject: 'PAYMENT FAILED', body: '' });
    expect(r!.severity).toBe('P0');
  });

  it('is accent-insensitive (NL diacritics)', () => {
    // The literal "duurder" contains no diacritics. Construct a variant
    // that has combining diacritics to prove they don't break matching.
    const accented = 'düurder'; // umlaut combining mark on 'u'
    const r = classifyKeywords({ subject: '', body: `De prijs werd ${accented} bij checkout.` });
    expect(r).not.toBeNull();
    expect(r!.severity).toBe('P1');
  });

  it('does NOT match "stripe" inside the URL "stripe.com"', () => {
    const r = classifyKeywords({
      subject: '',
      body: 'See https://stripe.com/docs for more info, no actual problem.',
    });
    expect(r).toBeNull();
  });

  it('does NOT match "stripe" inside "www.stripe.com"', () => {
    const r = classifyKeywords({ subject: '', body: 'Check www.stripe.com/payments — they have a doc.' });
    expect(r).toBeNull();
  });

  it('matches "stripe error" as a multi-word phrase even near URL-ish text', () => {
    const r = classifyKeywords({
      subject: '',
      body: 'Got a stripe error during checkout. (More info at https://stripe.com/docs.)',
    });
    expect(r!.severity).toBe('P0');
    expect(r!.keywords).toContain('stripe error');
  });

  it('strips HTML when body is empty but html provided', () => {
    const r = classifyKeywords({
      subject: '',
      body: '',
      html: '<p>Hallo, ik <b>kan niet betalen</b> op jullie site.</p>',
    });
    expect(r!.severity).toBe('P0');
  });

  it('multi-keyword multi-severity returns max severity (P0 wins)', () => {
    const r = classifyKeywords({
      subject: '',
      body: 'Mijn creditcard werkt niet en mijn voucher werkt niet.',
    });
    expect(r!.severity).toBe('P0');
    expect(r!.keywords).toContain('creditcard werkt niet');
    expect(r!.keywords).toContain('voucher werkt niet');
  });

  it('multi-keyword same-severity dedupes display-form keywords', () => {
    const r = classifyKeywords({
      subject: 'kan niet betalen',
      body: 'Ik kan niet betalen — kan niet betalen!! Ik probeerde stripe error.',
    });
    expect(r!.severity).toBe('P0');
    const kanNietBetalenCount = r!.keywords.filter((k) => k === 'kan niet betalen').length;
    expect(kanNietBetalenCount).toBe(1);
  });

  it('returns null when no keyword matches', () => {
    const r = classifyKeywords({
      subject: 'Algemene vraag',
      body: 'Hallo, wanneer zijn jullie openingstijden? Bedankt!',
    });
    expect(r).toBeNull();
  });

  it('runbook hint matches the top-severity class (P0 payment_blocked)', () => {
    const r = classifyKeywords({ subject: '', body: 'creditcard werkt niet' });
    expect(r!.runbook).toMatch(/payment_intents/i);
  });

  it('runbook hint for voucher_unusable references validateVoucher', () => {
    const r = classifyKeywords({ subject: '', body: 'voucher werkt niet' });
    expect(r!.runbook).toMatch(/validateVoucher/i);
  });

  it('runbook hint for price_drift references reservation + retry-attempt', () => {
    const r = classifyKeywords({ subject: '', body: 'De prijs is hoger geworden!' });
    expect(r!.runbook).toMatch(/retry-attempt/i);
  });

  it('runbook hint for no_availability references booking_error_events', () => {
    const r = classifyKeywords({ subject: '', body: 'Geen beschikbaarheid op die data.' });
    expect(r!.runbook).toMatch(/booking_error_events/i);
  });
});

describe('classifyKeywords — non-customer sender suppression', () => {
  // Regression for the 2026-05-26 false-positive cluster pair
  // (1779801012.168929 partner-side @phl-tickets.eu reply +
  // 1779802505.985619 staff @favotrip.nl reply on the same
  // "Wijzigingsverzoek bestelling 29096" thread). Both fired the
  // price_drift runbook on "duurder" matched in quoted upstream text.
  it('suppresses "duurder" on @favotrip.nl staff outbound reply', () => {
    const r = classifyKeywords({
      subject: 'Re: RE: Wijzigingsverzoek bestelling 29096',
      body: 'Bedankt voor je bericht, super fijn dat het mogelijk is! De optie is iets duurder maar de tickets zitten in de bijlage.',
      fromAddress: 'jeanne@favotrip.nl',
    });
    expect(r).toBeNull();
  });

  it('suppresses "duurder" on @phl-tickets.eu partner reply', () => {
    const r = classifyKeywords({
      subject: 'RE: Wijzigingsverzoek bestelling 29096',
      body: 'Yes the swap is possible — the new package is duurder by 12 EUR.',
      fromAddress: 'support@phl-tickets.eu',
    });
    expect(r).toBeNull();
  });

  it('suppresses on ratehawk.com partner reply', () => {
    const r = classifyKeywords({
      subject: 'Refund request',
      body: 'The new rate is duurder — please confirm if you accept.',
      fromAddress: 'noreply@ratehawk.com',
    });
    expect(r).toBeNull();
  });

  it('suppresses on subdomain of a partner (mail.ratehawk.com)', () => {
    const r = classifyKeywords({
      subject: '',
      body: 'kan niet betalen want het is duurder geworden',
      fromAddress: 'bot@mail.ratehawk.com',
    });
    expect(r).toBeNull();
  });

  it('still fires for the same content from a real customer domain', () => {
    const r = classifyKeywords({
      subject: 'Hulp',
      body: 'Bij het afrekenen werd alles duurder.',
      fromAddress: 'klant@gmail.com',
    });
    expect(r).not.toBeNull();
    expect(r!.severity).toBe('P1');
  });

  it('still fires when fromAddress is missing (backwards-compatible)', () => {
    const r = classifyKeywords({
      subject: 'Hulp',
      body: 'Bij het afrekenen werd alles duurder.',
    });
    expect(r).not.toBeNull();
    expect(r!.severity).toBe('P1');
  });
});

describe('isNonCustomerSender', () => {
  it('matches exact @favotrip.nl', () => {
    expect(isNonCustomerSender('jeanne@favotrip.nl')).toBe(true);
  });

  it('matches exact @phl-tickets.eu', () => {
    expect(isNonCustomerSender('support@phl-tickets.eu')).toBe(true);
  });

  it('matches subdomain of partner', () => {
    expect(isNonCustomerSender('bot@mail.ratehawk.com')).toBe(true);
  });

  it('is case-insensitive on the domain', () => {
    expect(isNonCustomerSender('Jeanne@Favotrip.NL')).toBe(true);
  });

  it('returns false for a real customer domain', () => {
    expect(isNonCustomerSender('klant@gmail.com')).toBe(false);
  });

  it('returns false for empty/missing input', () => {
    expect(isNonCustomerSender(undefined)).toBe(false);
    expect(isNonCustomerSender(null)).toBe(false);
    expect(isNonCustomerSender('')).toBe(false);
    expect(isNonCustomerSender('not-an-email')).toBe(false);
  });

  it('does NOT confuse a lookalike domain (favotrip.nl.attacker.example)', () => {
    expect(isNonCustomerSender('phish@favotrip.nl.attacker.example')).toBe(false);
  });
});

describe('stripHtml', () => {
  it('removes tags and decodes entities', () => {
    const out = stripHtml('<p>Hallo &amp; welkom <b>vriend</b>.</p>');
    expect(out).toBe('Hallo & welkom vriend.');
  });

  it('preserves text across <br> and block tags', () => {
    const out = stripHtml('<p>Regel 1</p><p>Regel 2</p>');
    expect(out).toMatch(/Regel 1/);
    expect(out).toMatch(/Regel 2/);
  });
});
