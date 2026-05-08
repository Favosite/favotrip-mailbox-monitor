import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RepeatedMailerStore } from './repeated-mailer.service.js';

const SALT = 'test-salt-fixed';

let tmpFile: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmstore-'));
  tmpFile = path.join(dir, 'sender-hashes.json');
});

afterEach(async () => {
  try {
    await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('RepeatedMailerStore', () => {
  it('hashes the same address to the same hash with same salt', () => {
    const a = RepeatedMailerStore.hashAddress('jan@example.com', SALT);
    const b = RepeatedMailerStore.hashAddress('JAN@Example.COM', SALT);
    expect(a).toBe(b);
  });

  it('hashes different addresses to different hashes', () => {
    const a = RepeatedMailerStore.hashAddress('jan@example.com', SALT);
    const b = RepeatedMailerStore.hashAddress('piet@example.com', SALT);
    expect(a).not.toBe(b);
  });

  it('does NOT persist the unmasked address', async () => {
    const s = new RepeatedMailerStore({
      filePath: tmpFile,
      salt: SALT,
      thresholdCount: 3,
      windowDays: 7,
    });
    await s.load();
    s.observe('confidential@example.com');
    await s.save();
    const raw = await fs.readFile(tmpFile, 'utf8');
    expect(raw).not.toContain('confidential');
    expect(raw).not.toContain('@example.com');
  });

  it('flags as repeated only at threshold count', async () => {
    const s = new RepeatedMailerStore({
      filePath: tmpFile,
      salt: SALT,
      thresholdCount: 3,
      windowDays: 7,
    });
    await s.load();
    expect(s.observe('a@b.com').isRepeated).toBe(false);
    expect(s.observe('a@b.com').isRepeated).toBe(false);
    expect(s.observe('a@b.com').isRepeated).toBe(true);
    expect(s.observe('a@b.com').count).toBe(4);
  });

  it('drops timestamps older than windowDays', async () => {
    const s = new RepeatedMailerStore({
      filePath: tmpFile,
      salt: SALT,
      thresholdCount: 3,
      windowDays: 7,
    });
    await s.load();
    const old = new Date('2020-01-01T00:00:00Z');
    s.observe('a@b.com', old);
    s.observe('a@b.com', old);
    const now = new Date();
    const r = s.observe('a@b.com', now);
    expect(r.count).toBe(1);
    expect(r.isRepeated).toBe(false);
  });

  it('roundtrips via save+load', async () => {
    const a = new RepeatedMailerStore({
      filePath: tmpFile,
      salt: SALT,
      thresholdCount: 3,
      windowDays: 7,
    });
    await a.load();
    a.observe('a@b.com');
    a.observe('a@b.com');
    await a.save();

    const b = new RepeatedMailerStore({
      filePath: tmpFile,
      salt: SALT,
      thresholdCount: 3,
      windowDays: 7,
    });
    await b.load();
    const r = b.observe('a@b.com');
    expect(r.isRepeated).toBe(true);
  });

  it('prune removes empty records', async () => {
    const s = new RepeatedMailerStore({
      filePath: tmpFile,
      salt: SALT,
      thresholdCount: 3,
      windowDays: 1,
    });
    await s.load();
    s.observe('a@b.com', new Date('2020-01-01T00:00:00Z'));
    s.prune(new Date());
    // After prune the empty record is gone — observing again should start fresh count=1.
    const r = s.observe('a@b.com');
    expect(r.count).toBe(1);
  });
});
