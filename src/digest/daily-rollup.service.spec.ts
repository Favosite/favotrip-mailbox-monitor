import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessedMail } from '../types.js';
import { SuppressedCountsStore } from '../state/suppressed-counts.service.js';
import type { SlackPoster } from './slack.service.js';
import { DailyRollupService, buildDailyRollupMessage } from './daily-rollup.service.js';

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

describe('buildDailyRollupMessage', () => {
  it('renders zero-day message', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), undefined);
    expect(text).toContain('2026-05-21');
    expect(text).toContain('0 suppressed');
  });

  it('renders bucket breakdown sorted by count desc', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), {
      totalSuppressed: 7,
      byBucket: { booking_question: 5, general_info: 2 },
    });
    expect(text).toContain('7 routine mails suppressed');
    const idxBQ = text.indexOf('booking_question');
    const idxGI = text.indexOf('general_info');
    expect(idxBQ).toBeGreaterThan(0);
    expect(idxGI).toBeGreaterThan(idxBQ);
  });

  it('mentions that time-sensitive buckets posted at arrival time', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), {
      totalSuppressed: 3,
      byBucket: { booking_question: 3 },
    });
    // Per Dennis 2026-05-22 second iteration: needs_human_review is no
    // longer an always-immediate bucket. The new footer lists the 3
    // remaining time-sensitive buckets + mentions content-urgent signals
    // (flags / keyword hits / URGENT_KEYWORDS) that override suppression.
    expect(text).toMatch(/cancellation\/refund\/partner.*immediately/);
    expect(text).toMatch(/URGENT_KEYWORDS|urgent/);
  });

  it('renders byReason breakdown when populated (NEW)', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), {
      totalSuppressed: 5,
      byBucket: { booking_question: 4, needs_human_review: 1 },
      byReason: {
        low_priority: 3,
        repeated_mailer_only: 1,
        needs_human_review_nonurgent: 1,
      },
    });
    expect(text).toMatch(/Reason breakdown/);
    expect(text).toMatch(/3 routine LOW/);
    expect(text).toMatch(/repeated_mailer noise/);
    expect(text).toMatch(/needs_human_review without urgent/);
  });

  it('omits Reason breakdown for legacy entries without byReason (backward compat)', () => {
    const text = buildDailyRollupMessage(new Date('2026-05-21T00:00:00Z'), {
      totalSuppressed: 3,
      byBucket: { booking_question: 3 },
      // byReason absent
    });
    expect(text).not.toMatch(/Reason breakdown/);
    expect(text).toMatch(/Bucket breakdown/);
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

  it('posts when yesterday had suppressed mails', async () => {
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
    expect(slack.posted[0]).toContain('2026-05-21');
    expect(slack.posted[0]).toContain('2 routine');
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

  it('skipPostOnZero=false posts zero-day notice', async () => {
    const store = new SuppressedCountsStore(filePath);
    await store.load();
    const slack = new CapturePoster();
    const svc = new DailyRollupService({ store, slack, skipPostOnZero: false });
    await svc.runOnce(new Date('2026-05-22T08:00:00Z'));
    expect(slack.posted.length).toBe(1);
    expect(slack.posted[0]).toContain('0 suppressed');
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
