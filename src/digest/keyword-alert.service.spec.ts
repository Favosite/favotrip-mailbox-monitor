import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  KeywordAlertService,
  KeywordDedupeStore,
  buildKeywordAlertMessage,
  computeDedupeKey,
  computeThreadId,
} from './keyword-alert.service.js';
import type { ProcessedMail } from '../types.js';
import type { KeywordHit } from '../classifier/keyword-monitor.service.js';
import type { SlackPoster } from './slack.service.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keyword-alert-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function mkMail(over: Partial<ProcessedMail> = {}): ProcessedMail {
  return {
    uid: 1,
    fromHash: 'abc123',
    maskedFrom: 'c***r@example.com <naam-gemaskeerd>',
    maskedSubject: 'Kan niet betalen op de site',
    maskedBody: 'Hallo, ik kan al de hele middag niet betalen op jullie site, kan iemand mij helpen?',
    manualOnly: false,
    date: new Date('2026-05-21T13:42:00Z'),
    bucket: 'booking_question',
    confidence: 0.8,
    flags: [],
    priority: 'NORMAL',
    ...over,
  };
}

function mkHit(over: Partial<KeywordHit> = {}): KeywordHit {
  return {
    severity: 'P0',
    keywords: ['kan niet betalen'],
    runbook: 'Check payment_intents for the reservation...',
    ...over,
  };
}

describe('computeThreadId', () => {
  it('is stable across calls with same inputs', () => {
    const a = computeThreadId('hash1', 'Vraag over voucher', 'salt');
    const b = computeThreadId('hash1', 'Vraag over voucher', 'salt');
    expect(a).toBe(b);
  });

  it('strips Re:/Fwd: prefixes so reply-chains collapse', () => {
    const a = computeThreadId('h', 'Vraag over voucher', 's');
    const b = computeThreadId('h', 'Re: Vraag over voucher', 's');
    const c = computeThreadId('h', 'Fwd: Re: Vraag over voucher', 's');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('changes when salt changes', () => {
    const a = computeThreadId('h', 's', 'salt1');
    const b = computeThreadId('h', 's', 'salt2');
    expect(a).not.toBe(b);
  });

  it('changes when fromHash changes', () => {
    const a = computeThreadId('hashA', 's', 'salt');
    const b = computeThreadId('hashB', 's', 'salt');
    expect(a).not.toBe(b);
  });
});

describe('computeDedupeKey', () => {
  it('shape is severity|thread|day_utc', () => {
    const k = computeDedupeKey('P0', 'tid', new Date('2026-05-21T13:42:00Z'));
    expect(k).toBe('P0|tid|2026-05-21');
  });

  it('same thread same day same severity = same key', () => {
    const k1 = computeDedupeKey('P0', 't', new Date('2026-05-21T01:00:00Z'));
    const k2 = computeDedupeKey('P0', 't', new Date('2026-05-21T23:00:00Z'));
    expect(k1).toBe(k2);
  });

  it('different day = different key', () => {
    const k1 = computeDedupeKey('P0', 't', new Date('2026-05-21T23:00:00Z'));
    const k2 = computeDedupeKey('P0', 't', new Date('2026-05-22T00:30:00Z'));
    expect(k1).not.toBe(k2);
  });

  it('different severity = different key (P0 vs P1 same thread same day)', () => {
    const d = new Date('2026-05-21T10:00:00Z');
    expect(computeDedupeKey('P0', 't', d)).not.toBe(computeDedupeKey('P1', 't', d));
  });
});

describe('KeywordDedupeStore', () => {
  it('persists and reloads emitted keys', async () => {
    const fp = path.join(dir, 'kd.json');
    const s1 = new KeywordDedupeStore(fp);
    await s1.load();
    s1.mark('P0|abc|2026-05-21', new Date('2026-05-21T10:00:00Z'));
    await s1.save();

    const s2 = new KeywordDedupeStore(fp);
    await s2.load();
    expect(s2.has('P0|abc|2026-05-21')).toBe(true);
  });

  it('prune drops entries older than keepDays', async () => {
    const fp = path.join(dir, 'kd.json');
    const s = new KeywordDedupeStore(fp);
    await s.load();
    s.mark('old', new Date('2026-05-01T00:00:00Z'));
    s.mark('fresh', new Date('2026-05-21T00:00:00Z'));
    s.prune(new Date('2026-05-21T10:00:00Z'), 14);
    expect(s.has('old')).toBe(false);
    expect(s.has('fresh')).toBe(true);
  });

  it('returns false on first encounter, throws if load() missed', () => {
    const s = new KeywordDedupeStore(path.join(dir, 'kd.json'));
    expect(() => s.has('x')).toThrow(/load\(\) not called/);
  });
});

describe('buildKeywordAlertMessage', () => {
  it('uses :rotating_light: icon for P0', () => {
    const txt = buildKeywordAlertMessage({
      mail: mkMail(),
      hit: mkHit({ severity: 'P0' }),
      threadId: 'tid123',
    });
    expect(txt).toMatch(/:rotating_light:/);
    expect(txt).toMatch(/\*P0 mailbox-keyword/);
  });

  it('uses :warning: icon for P1', () => {
    const txt = buildKeywordAlertMessage({
      mail: mkMail({ maskedSubject: 'Voucher klacht' }),
      hit: mkHit({ severity: 'P1', keywords: ['voucher werkt niet'] }),
      threadId: 'tid123',
    });
    expect(txt).toMatch(/:warning:/);
    expect(txt).toMatch(/\*P1 mailbox-keyword/);
  });

  it('has NO @-mentions (no <@U...>, <!channel>, <!here>)', () => {
    const txt = buildKeywordAlertMessage({
      mail: mkMail(),
      hit: mkHit(),
      threadId: 'tid123',
    });
    expect(txt).not.toMatch(/<@/);
    expect(txt).not.toMatch(/<!channel>/);
    expect(txt).not.toMatch(/<!here>/);
  });

  it('includes the runbook hint as a separate line', () => {
    const txt = buildKeywordAlertMessage({
      mail: mkMail(),
      hit: mkHit({ runbook: 'CUSTOM_RUNBOOK_HINT_42' }),
      threadId: 'tid',
    });
    expect(txt).toMatch(/_Runbook:_ CUSTOM_RUNBOOK_HINT_42/);
  });

  it('trims subject to 80 chars + body-quote to 120 chars', () => {
    const longSubj = 'A'.repeat(200);
    const longBody = 'B'.repeat(500);
    const txt = buildKeywordAlertMessage({
      mail: mkMail({ maskedSubject: longSubj, maskedBody: longBody }),
      hit: mkHit(),
      threadId: 'tid',
    });
    const subjectLine = txt.split('\n').find((l) => l.startsWith('- subject:')) ?? '';
    expect(subjectLine.length).toBeLessThanOrEqual(80 + '- subject: '.length);
    const quoteLine = txt.split('\n').find((l) => l.startsWith('- mail-quote:')) ?? '';
    expect(quoteLine.length).toBeLessThanOrEqual(120 + '- mail-quote: '.length);
  });

  it('uses redacted placeholder for manual-only mails', () => {
    const txt = buildKeywordAlertMessage({
      mail: mkMail({
        manualOnly: true,
        maskedBody: '[REDACTED — manual-only: contains sensitive financial or medical content]',
      }),
      hit: mkHit(),
      threadId: 'tid',
    });
    expect(txt).toMatch(/REDACTED/);
  });

  it('includes the via-Claude footer + keywords JSON array', () => {
    const txt = buildKeywordAlertMessage({
      mail: mkMail(),
      hit: mkHit({ keywords: ['kan niet betalen', 'stripe error'] }),
      threadId: 'tid',
    });
    expect(txt).toMatch(/_via_ Claude/);
    expect(txt).toMatch(/keywords hit: \["kan niet betalen","stripe error"\]/);
  });
});

describe('KeywordAlertService.flush', () => {
  class FakePoster implements SlackPoster {
    posts: string[] = [];
    shouldThrow = false;
    async post(text: string): Promise<void> {
      if (this.shouldThrow) throw new Error('boom');
      this.posts.push(text);
    }
  }

  it('posts one alert per unique (severity, thread, day)', async () => {
    const poster = new FakePoster();
    const store = new KeywordDedupeStore(path.join(dir, 'k.json'));
    await store.load();
    const svc = new KeywordAlertService({ poster, store, salt: 'salt' });

    const mails: ProcessedMail[] = [
      { ...mkMail({ uid: 1 }), keywordHit: mkHit() },
      { ...mkMail({ uid: 2 }), keywordHit: mkHit() }, // SAME from+subject -> same thread+day -> dedupe
    ];
    const r = await svc.flush(mails);
    expect(r.emitted).toBe(1);
    expect(r.skippedDedupe).toBe(1);
    expect(poster.posts).toHaveLength(1);
  });

  it('skips mails without a keywordHit', async () => {
    const poster = new FakePoster();
    const store = new KeywordDedupeStore(path.join(dir, 'k.json'));
    await store.load();
    const svc = new KeywordAlertService({ poster, store, salt: 'salt' });
    const mails: ProcessedMail[] = [mkMail({ uid: 1 })]; // no keywordHit
    const r = await svc.flush(mails);
    expect(r.emitted).toBe(0);
    expect(poster.posts).toHaveLength(0);
  });

  it('counts errors but does not throw', async () => {
    const poster = new FakePoster();
    poster.shouldThrow = true;
    const store = new KeywordDedupeStore(path.join(dir, 'k.json'));
    await store.load();
    const svc = new KeywordAlertService({ poster, store, salt: 'salt' });
    const r = await svc.flush([{ ...mkMail(), keywordHit: mkHit() }]);
    expect(r.errors).toBe(1);
    expect(r.emitted).toBe(0);
    // Store must NOT mark on failed post
    expect(store.has('P0|' + computeThreadId('abc123', 'Kan niet betalen op de site', 'salt') + '|2026-05-21')).toBe(false);
  });

  it('posts again next day (day-rollover resets dedupe)', async () => {
    const poster = new FakePoster();
    const store = new KeywordDedupeStore(path.join(dir, 'k.json'));
    await store.load();
    const svc = new KeywordAlertService({ poster, store, salt: 'salt' });

    const mailDay1 = { ...mkMail({ uid: 1, date: new Date('2026-05-21T10:00:00Z') }), keywordHit: mkHit() };
    const mailDay2 = { ...mkMail({ uid: 2, date: new Date('2026-05-22T10:00:00Z') }), keywordHit: mkHit() };

    const r1 = await svc.flush([mailDay1]);
    const r2 = await svc.flush([mailDay2]);
    expect(r1.emitted).toBe(1);
    expect(r2.emitted).toBe(1);
    expect(poster.posts).toHaveLength(2);
  });
});
