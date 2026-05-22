import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessedMail } from '../types.js';
import { SuppressedCountsStore } from './suppressed-counts.service.js';

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suppressed-counts-'));
  filePath = path.join(dir, 'counts.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function mkMail(overrides: Partial<ProcessedMail> = {}): ProcessedMail {
  return {
    uid: 1,
    fromHash: 'h',
    maskedFrom: 'mf',
    maskedSubject: 'ms',
    maskedBody: 'mb',
    manualOnly: false,
    date: new Date(),
    bucket: 'booking_question',
    confidence: 0.9,
    flags: [],
    priority: 'NORMAL',
    keywordHit: null,
    ...overrides,
  };
}

describe('SuppressedCountsStore', () => {
  it('add() + getDay() round-trip', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    const now = new Date('2026-05-22T10:00:00Z');
    store.add([mkMail(), mkMail({ uid: 2 })], now);
    const day = store.getDay(now);
    expect(day?.totalSuppressed).toBe(2);
    expect(day?.byBucket.booking_question).toBe(2);
  });

  it('save() persists to disk and load() restores', async () => {
    const a = new SuppressedCountsStore(filePath);
    await a.load();
    a.add([mkMail({ bucket: 'booking_question' }), mkMail({ uid: 2, bucket: 'general_info' })],
      new Date('2026-05-22T10:00:00Z'));
    await a.save();

    const b = new SuppressedCountsStore(filePath);
    await b.load();
    const day = b.getDay(new Date('2026-05-22T10:00:00Z'));
    expect(day?.totalSuppressed).toBe(2);
    expect(day?.byBucket.booking_question).toBe(1);
    expect(day?.byBucket.general_info).toBe(1);
  });

  it('aggregates across multiple add() calls on the same day', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    const t1 = new Date('2026-05-22T10:00:00Z');
    const t2 = new Date('2026-05-22T10:30:00Z');
    store.add([mkMail()], t1);
    store.add([mkMail({ uid: 2 }), mkMail({ uid: 3 })], t2);
    expect(store.getDay(t1)?.totalSuppressed).toBe(3);
    expect(store.getDay(t1)?.lastSuppressedAt).toBe(t2.toISOString());
  });

  it('separates counts per day (UTC)', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    store.add([mkMail()], new Date('2026-05-21T23:00:00Z'));
    store.add([mkMail({ uid: 2 })], new Date('2026-05-22T01:00:00Z'));
    expect(store.listDays()).toEqual(['2026-05-21', '2026-05-22']);
  });

  it('prune() drops entries older than keepDays', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    const old = new Date('2026-05-01T10:00:00Z');
    const recent = new Date('2026-05-22T10:00:00Z');
    store.add([mkMail()], old);
    store.add([mkMail({ uid: 2 })], recent);
    store.prune(recent, 14);
    expect(store.listDays()).toEqual(['2026-05-22']);
  });

  it('add([]) is a no-op', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    store.add([], new Date('2026-05-22T10:00:00Z'));
    expect(store.listDays()).toEqual([]);
  });

  it('throws when used before load()', () => {
    const store = new SuppressedCountsStore(filePath);
    expect(() => store.add([mkMail()], new Date())).toThrow(/load\(\) not called/);
  });
});
