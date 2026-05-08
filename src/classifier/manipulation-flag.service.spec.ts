import { describe, expect, it } from 'vitest';
import { detectManipulationFlags } from './manipulation-flag.service.js';

describe('manipulation flag — sob_story_money', () => {
  it('fires on refund + ziek combo', () => {
    const flags = detectManipulationFlags(
      '',
      'Ik wil mijn geld terug, mijn moeder is ziek en ik kan niet komen.',
    );
    expect(flags).toContain('sob_story_money');
  });

  it('does NOT fire on benign refund question', () => {
    const flags = detectManipulationFlags(
      'Refund vraag',
      'Hoe lang duurt een refund normaal gezien?',
    );
    expect(flags).not.toContain('sob_story_money');
  });

  it('fires on geld terug + advocaat combo', () => {
    const flags = detectManipulationFlags(
      '',
      'Als ik mijn geld terug niet krijg, schakel ik mijn advocaat in.',
    );
    expect(flags).toContain('sob_story_money');
    expect(flags).toContain('legal_threat');
  });
});

describe('manipulation flag — legal_threat', () => {
  it('fires on rechtbank mention', () => {
    const flags = detectManipulationFlags('', 'Ik stap naar de rechtbank als jullie niet reageren.');
    expect(flags).toContain('legal_threat');
  });

  it('fires on AFM mention', () => {
    const flags = detectManipulationFlags('Klacht', 'Dit meld ik bij de AFM.');
    expect(flags).toContain('legal_threat');
  });
});

describe('manipulation flag — chargeback', () => {
  it('fires on chargeback word', () => {
    const flags = detectManipulationFlags('', 'I will file a chargeback if not resolved today.');
    expect(flags).toContain('chargeback');
  });

  it('fires on Dutch terugboeking', () => {
    const flags = detectManipulationFlags('', 'Mijn bank doet een terugboeking.');
    expect(flags).toContain('chargeback');
  });
});

describe('manipulation flag — benign baseline', () => {
  it('returns empty for plain booking question', () => {
    const flags = detectManipulationFlags('Voucher code', 'Hoe verzilver ik mijn voucher?');
    expect(flags).toEqual([]);
  });
});
