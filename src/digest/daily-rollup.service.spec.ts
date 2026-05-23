import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessedMail } from '../types.js';
import { SuppressedCountsStore } from '../state/suppressed-counts.service.js';
import type { SlackPoster } from './slack.service.js';
import { DailyRollupService, buildDailyRollupDetail, buildDailyRollupMessage } from './daily-rollup.service.js';

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-rollup-'));
  filePath = path.join(dir, 'counts.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

class CapturePoster implements SlackPoster {
  posted: string[] = [];
  async post(text: string): Promise<void> {
    this.posted.push(text);
  }
}

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

describe('buildDailyRollupMessage — 2026-05-23 rollup-formatting spec (Dennis)', () => {
  it('zero-day message is one line and says "Geen actie nodig"', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), undefined);
    expect(text.split('\n').length).toBe(1);
    expect(text).toContain('2026-05-21');
    expect(text).toContain('0 routine mails onderdrukt');
    expect(text).toContain('Geen actie nodig');
  });

  it('non-zero rollup is also one line and says "Geen actie nodig"', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), {
      totalSuppressed: 7,
      byBucket: { booking_question: 5, general_info: 2 },
    });
    expect(text.split('\n').length).toBe(1);
    expect(text).toContain('2026-05-21');
    expect(text).toContain('7 routine mails onderdrukt');
    expect(text).toContain('Geen actie nodig');
  });

  it('singular form: 1 mail (not "1 mails")', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), {
      totalSuppressed: 1,
      byBucket: { booking_question: 1 },
    });
    expect(text).toContain('1 routine mail onderdrukt');
    expect(text).not.toContain('1 routine mails');
  });

  it('NO bucket breakdown leaks top-level in #team payload', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), {
      totalSuppressed: 7,
      byBucket: { booking_question: 5, general_info: 2 },
    });
    for (const banned of [
      'booking_question',
      'general_info',
      'Bucket breakdown',
      'cancellation_request',
      'refund_request',
      'needs_human_review',
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it('NO reason breakdown leaks top-level in #team payload', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), {
      totalSuppressed: 5,
      byBucket: { booking_question: 4, needs_human_review: 1 },
      byReason: {
        low_priority: 3,
        repeated_mailer_only: 1,
        needs_human_review_nonurgent: 1,
      },
    });
    for (const banned of [
      'Reason breakdown',
      'routine LOW',
      'repeated_mailer',
      'needs_human_review',
      'low_priority',
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it('NO "which signals still post immediately" footer in #team payload', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), {
      totalSuppressed: 3,
      byBucket: { booking_question: 3 },
    });
    expect(text).not.toMatch(/cancellation\/refund\/partner/);
    expect(text).not.toMatch(/URGENT_KEYWORDS|urgent/i);
    expect(text).not.toMatch(/Time-sensitive/i);
    expect(text).not.toMatch(/immediate/i);
  });
});

describe('buildDailyRollupDetail — structured-log payload (NOT #team)', () => {
  it('returns null for zero-suppressed days', () => {
    expect(buildDailyRollupDetail(new Date('2026-05-21T00:00:00Z'), undefined)).toBeNull();
    expect(
      buildDailyRollupDetail(new Date('2026-05-21T00:00:00Z'), {
        totalSuppressed: 0,
        byBucket: {},
      }),
    ).toBeNull();
  });

  it('renders full bucket + reason breakdown for the structured log', () => {
    const d = buildDailyRollupDetail(new Date('2026-05-21T00:00:00Z'), {
      totalSuppressed: 5,
      byBucket: { booking_question: 4, needs_human_review: 1 },
      byReason: { low_priority: 4, needs_human_review_nonurgent: 1 },
    });
    expect(d).not.toBeNull();
    expect(d!.day).toBe('2026-05-21');
    expect(d!.totalSuppressed).toBe(5);
    expect(d!.byBucket).toEqual({ booking_question: 4, needs_human_review: 1 });
    expect(d!.byReason).toEqual({ low_priority: 4, needs_human_review_nonurgent: 1 });
  });
});

describe('DailyRollupService', () => {
  it('skips post when yesterday had zero suppressed mails (default)', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    const slack = new CapturePoster();
    const svc = new DailyRollupService({ store, slack });
    await svc.runOnce(new Date('2026-05-22T08:00:00Z'));
    expect(slack.posted.length).toBe(0);
  });

  it('posts when yesterday had suppressed mails (1-line, Geen actie nodig)', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    store.add([mkMail(), mkMail({ uid: 2 })], new Date('2026-05-21T10:00:00Z'));
    await store.save();

    const slack = new CapturePoster();
    const svc = new DailyRollupService({
      store: new SuppressedCountsStore(filePath),
      slack,
    });
    await svc.runOnce(new Date('2026-05-22T08:00:00Z'));
    expect(slack.posted.length).toBe(1);
    const text = slack.posted[0];
    expect(text.split('\n').length).toBe(1);
    expect(text).toContain('2026-05-21');
    expect(text).toContain('2 routine mails onderdrukt');
    expect(text).toContain('Geen actie nodig');
    // No bucket / reason / footer leakage:
    expect(text).not.toContain('booking_question');
    expect(text).not.toMatch(/Reason breakdown/);
    expect(text).not.toMatch(/cancellation\/refund/);
  });

  it('reports yesterday, not today', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    store.add([mkMail()], new Date('2026-05-22T07:00:00Z'));
    await store.save();

    const slack = new CapturePoster();
    const svc = new DailyRollupService({
      store: new SuppressedCountsStore(filePath),
      slack,
    });
    await svc.runOnce(new Date('2026-05-22T08:00:00Z'));
    expect(slack.posted.length).toBe(0);
  });

  it('skipPostOnZero=false posts zero-day notice in the new 1-line shape', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    const slack = new CapturePoster();
    const svc = new DailyRollupService({ store, slack, skipPostOnZero: false });
    await svc.runOnce(new Date('2026-05-22T08:00:00Z'));
    expect(slack.posted.length).toBe(1);
    expect(slack.posted[0]).toContain('0 routine mails onderdrukt');
    expect(slack.posted[0]).toContain('Geen actie nodig');
  });

  it('swallows slack post errors (does not crash daily cron)', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    store.add([mkMail()], new Date('2026-05-21T10:00:00Z'));
    await store.save();

    class FailingPoster implements SlackPoster {
      async post(): Promise<void> {
        throw new Error('slack-network-error');
      }
    }
    const svc = new DailyRollupService({
      store: new SuppressedCountsStore(filePath),
      slack: new FailingPoster(),
    });
    await expect(svc.runOnce(new Date('2026-05-22T08:00:00Z'))).resolves.toBeUndefined();
  });
});
