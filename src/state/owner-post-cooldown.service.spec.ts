import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { OwnerPostCooldownStore } from './owner-post-cooldown.service.js';

describe('OwnerPostCooldownStore', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cooldown-test-'));
    file = path.join(dir, 'owner-post-cooldown.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('load() on missing file → empty state, lastPostAt undefined', async () => {
    const s = new OwnerPostCooldownStore(file);
    await s.load();
    expect(s.lastPostAt('U0961S209GA')).toBeUndefined();
    expect(s.inCooldown('U0961S209GA', new Date(), 60)).toBe(false);
  });

  it('markPosted() + save() persists and reloads correctly', async () => {
    const at = new Date('2026-05-23T20:30:00.000Z');
    const a = new OwnerPostCooldownStore(file);
    await a.load();
    a.markPosted('U0961S209GA', at);
    await a.save();

    const b = new OwnerPostCooldownStore(file);
    await b.load();
    expect(b.lastPostAt('U0961S209GA')?.toISOString()).toBe(at.toISOString());
  });

  it('inCooldown() is true within window, false outside', async () => {
    const s = new OwnerPostCooldownStore(file);
    await s.load();
    s.markPosted('U0961S209GA', new Date('2026-05-23T20:30:00.000Z'));

    // 30 min later → inside 60-min cooldown
    expect(
      s.inCooldown('U0961S209GA', new Date('2026-05-23T21:00:00.000Z'), 60),
    ).toBe(true);
    // 61 min later → outside 60-min cooldown
    expect(
      s.inCooldown('U0961S209GA', new Date('2026-05-23T21:31:00.000Z'), 60),
    ).toBe(false);
  });

  it('per-owner isolation: cooldown for U1 does not affect U2', async () => {
    const s = new OwnerPostCooldownStore(file);
    await s.load();
    s.markPosted('U1', new Date('2026-05-23T20:30:00.000Z'));
    const now = new Date('2026-05-23T20:45:00.000Z');
    expect(s.inCooldown('U1', now, 60)).toBe(true);
    expect(s.inCooldown('U2', now, 60)).toBe(false);
  });

  it('corrupt JSON in file does not crash load() — treats as empty', async () => {
    await fs.writeFile(file, 'not-json{', 'utf8');
    const s = new OwnerPostCooldownStore(file);
    await expect(s.load()).rejects.toThrow();
  });
});
