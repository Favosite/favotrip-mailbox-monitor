import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LastRunStore } from './last-run.service.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lrs-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('LastRunStore', () => {
  it('returns 5-min lookback when file is missing', async () => {
    const s = new LastRunStore(path.join(dir, 'state.json'));
    const r = await s.read();
    const ageMin = (Date.now() - r.lastFetchAt.getTime()) / 60_000;
    expect(ageMin).toBeGreaterThan(4);
    expect(ageMin).toBeLessThan(6);
    expect(r.lastZeroPostAt).toBeUndefined();
  });

  it('roundtrips lastFetchAt and lastZeroPostAt', async () => {
    const s = new LastRunStore(path.join(dir, 'state.json'));
    const fetchAt = new Date('2026-05-08T10:00:00Z');
    const zeroAt = new Date('2026-05-08T09:30:00Z');
    await s.write({ lastFetchAt: fetchAt, lastZeroPostAt: zeroAt });
    const r = await s.read();
    expect(r.lastFetchAt.toISOString()).toBe(fetchAt.toISOString());
    expect(r.lastZeroPostAt?.toISOString()).toBe(zeroAt.toISOString());
  });

  it('creates parent dir if missing', async () => {
    const s = new LastRunStore(path.join(dir, 'nested', 'deeper', 'state.json'));
    await s.write({ lastFetchAt: new Date('2026-05-08T10:00:00Z') });
    const r = await s.read();
    expect(r.lastFetchAt).toBeInstanceOf(Date);
  });
});
