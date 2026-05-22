import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.js';
import { DigestRunner } from './runner.js';
import type { ImapCredentials } from './imap/imap.service.js';
import type { SecretsClient } from './secrets/secrets.service.js';
import type { SlackPoster } from './digest/slack.service.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function mkCfg(overrides: Partial<Config> = {}): Config {
  return {
    IMAP_USERNAME: 'klantenservice@favotrip.nl',
    IMAP_HOST: 'imap.example.com',
    IMAP_PORT: 993,
    IMAP_MAILBOX: '[Gmail]/All Mail',
    IMAP_SECRET_ID: 'fake',
    AWS_REGION: 'eu-west-1',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x',
    SLACK_CHANNEL: '#team',
    CRON_SCHEDULE: '*/5 * * * *',
    STATE_FILE: path.join(dir, 'state.json'),
    HASH_STORE_FILE: path.join(dir, 'hash.json'),
    HASH_SALT: 'a-test-salt',
    ZERO_MAIL_POST_INTERVAL_MIN: 60,
    REPEATED_MAILER_THRESHOLD: 3,
    REPEATED_MAILER_WINDOW_DAYS: 7,
    DRY_RUN: true,
    LOG_LEVEL: 'info',
    QUEUE_TASK_TIMEOUT_MS: 10000,
    KEYWORD_DEDUPE_FILE: path.join(dir, 'keyword-dedupe.json'),
    SUPPRESSED_COUNTS_FILE: path.join(dir, 'suppressed-counts.json'),
    SUPPRESS_LOW_PRIORITY_DISABLED: false,
    DAILY_ROLLUP_CRON: '0 8 * * *',
    ...overrides,
  };
}

class FakeSecrets implements SecretsClient {
  async getImapCredentials(_id: string): Promise<ImapCredentials> {
    return {
      host: 'imap.example.com',
      port: 993,
      user: 'klantenservice@favotrip.nl',
      password: 'x',
    };
  }
}

class CapturePoster implements SlackPoster {
  posted: string[] = [];
  async post(text: string): Promise<void> {
    this.posted.push(text);
  }
}

describe('DigestRunner', () => {
  it('rate-limits zero-mail post: first run posts, second within window does not', async () => {
    const cfg = mkCfg({ ZERO_MAIL_POST_INTERVAL_MIN: 60 });
    const slack = new CapturePoster();

    // Stub the IMAP fetch by mocking ImapFetchService prototype.
    const { ImapFetchService } = await import('./imap/imap.service.js');
    const spy = vi
      .spyOn(ImapFetchService.prototype, 'fetchSince')
      .mockResolvedValue([]);

    const runner = new DigestRunner({
      cfg,
      secrets: new FakeSecrets(),
      slack,
      log: () => {},
    });

    const t1 = new Date('2026-05-08T10:00:00Z');
    await runner.runOnce(t1);
    expect(slack.posted.length).toBe(1);
    expect(slack.posted[0]).toContain('0 mails');

    const t2 = new Date(t1.getTime() + 30 * 60_000);
    await runner.runOnce(t2);
    expect(slack.posted.length).toBe(1);

    const t3 = new Date(t1.getTime() + 61 * 60_000);
    await runner.runOnce(t3);
    expect(slack.posted.length).toBe(2);

    spy.mockRestore();
  });

  it('posts a digest when there are mails', async () => {
    const cfg = mkCfg();
    const slack = new CapturePoster();

    const { ImapFetchService } = await import('./imap/imap.service.js');
    const spy = vi.spyOn(ImapFetchService.prototype, 'fetchSince').mockResolvedValue([
      {
        uid: 1,
        fromAddress: 'jan@example.com',
        fromName: 'Jan Jansen',
        toAddress: 'klantenservice@favotrip.nl',
        subject: 'Annulering FT-AB-CD-EF',
        body: 'Wij willen onze annulering doorgeven.',
        date: new Date('2026-05-08T10:00:00Z'),
        reservationCode: 'FT-AB-CD-EF',
      },
    ]);

    const runner = new DigestRunner({
      cfg,
      secrets: new FakeSecrets(),
      slack,
      log: () => {},
    });

    await runner.runOnce(new Date('2026-05-08T10:01:00Z'));
    expect(slack.posted.length).toBe(1);
    expect(slack.posted[0]).toContain('Klantenservice digest');
    expect(slack.posted[0]).toContain('cancellation_request');
    spy.mockRestore();
  });

  it('LOW-priority booking_question: does NOT post immediate #team digest', async () => {
    const cfg = mkCfg();
    const slack = new CapturePoster();

    const { ImapFetchService } = await import('./imap/imap.service.js');
    const spy = vi.spyOn(ImapFetchService.prototype, 'fetchSince').mockResolvedValue([
      {
        uid: 1,
        fromAddress: 'kees@example.com',
        toAddress: 'klantenservice@favotrip.nl',
        subject: 'Vraag over mijn boeking',
        body: 'Kan iemand mij helpen met informatie over mijn boeking?',
        date: new Date('2026-05-22T10:10:00Z'),
      },
    ]);

    const runner = new DigestRunner({
      cfg,
      secrets: new FakeSecrets(),
      slack,
      log: () => {},
    });

    await runner.runOnce(new Date('2026-05-22T10:11:00Z'));
    expect(slack.posted.length).toBe(0);

    // Counts persisted to suppressed-counts state file
    const raw = await fs.readFile(cfg.SUPPRESSED_COUNTS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, { totalSuppressed: number; byBucket: Record<string, number> }>;
    expect(parsed['2026-05-22']?.totalSuppressed).toBe(1);

    spy.mockRestore();
  });

  it('HIGH-flag booking_question (manipulation flag): STILL posts immediate #team digest', async () => {
    const cfg = mkCfg();
    const slack = new CapturePoster();

    const { ImapFetchService } = await import('./imap/imap.service.js');
    const spy = vi.spyOn(ImapFetchService.prototype, 'fetchSince').mockResolvedValue([
      {
        uid: 1,
        fromAddress: 'klant@example.nl',
        toAddress: 'klantenservice@favotrip.nl',
        subject: 'Vraag over mijn boeking',
        body: 'Ik heb een vraag over mijn boeking en als jullie dit niet oplossen schakel ik een advocaat in.',
        date: new Date('2026-05-22T10:10:00Z'),
      },
    ]);

    const runner = new DigestRunner({
      cfg,
      secrets: new FakeSecrets(),
      slack,
      log: () => {},
    });

    await runner.runOnce(new Date('2026-05-22T10:11:00Z'));
    expect(slack.posted.length).toBe(1);
    expect(slack.posted[0]).toContain('Klantenservice digest');
    expect(slack.posted[0]).toMatch(/HIGH|legal_threat/);
    spy.mockRestore();
  });

  it('P0/P1 keyword hit: posts to #alerts via alertsSlack AND posts digest to #team', async () => {
    const cfg = mkCfg({ SLACK_CHANNEL_ALERTS: 'C0AQPR9ECE9' });
    const teamSlack = new CapturePoster();
    const alertsSlack = new CapturePoster();

    const { ImapFetchService } = await import('./imap/imap.service.js');
    const spy = vi.spyOn(ImapFetchService.prototype, 'fetchSince').mockResolvedValue([
      {
        uid: 1,
        fromAddress: 'klant@example.nl',
        toAddress: 'klantenservice@favotrip.nl',
        subject: 'Probleem met betaling',
        body: 'Ik kan niet betalen op de site, de iDEAL knop werkt niet en ik krijg foutmelding na foutmelding.',
        date: new Date('2026-05-22T10:10:00Z'),
      },
    ]);

    const runner = new DigestRunner({
      cfg,
      secrets: new FakeSecrets(),
      slack: teamSlack,
      alertsSlack,
      log: () => {},
    });

    await runner.runOnce(new Date('2026-05-22T10:11:00Z'));
    expect(alertsSlack.posted.length).toBe(1);
    expect(alertsSlack.posted[0]).toMatch(/P0|P1/);
    expect(teamSlack.posted.length).toBe(1);
    expect(teamSlack.posted[0]).toContain('Klantenservice digest');
    spy.mockRestore();
  });

  it('zero-mail digest rate-limit still applies (existing policy unchanged)', async () => {
    const cfg = mkCfg({ ZERO_MAIL_POST_INTERVAL_MIN: 60 });
    const slack = new CapturePoster();

    const { ImapFetchService } = await import('./imap/imap.service.js');
    const spy = vi
      .spyOn(ImapFetchService.prototype, 'fetchSince')
      .mockResolvedValue([]);

    const runner = new DigestRunner({
      cfg,
      secrets: new FakeSecrets(),
      slack,
      log: () => {},
    });

    const t1 = new Date('2026-05-22T10:00:00Z');
    await runner.runOnce(t1);
    expect(slack.posted.length).toBe(1);

    const t2 = new Date(t1.getTime() + 30 * 60_000);
    await runner.runOnce(t2);
    expect(slack.posted.length).toBe(1);

    spy.mockRestore();
  });

  it('SUPPRESS_LOW_PRIORITY_DISABLED=true reverts to pre-fix behaviour (LOW posts to #team)', async () => {
    const cfg = mkCfg({ SUPPRESS_LOW_PRIORITY_DISABLED: true });
    const slack = new CapturePoster();

    const { ImapFetchService } = await import('./imap/imap.service.js');
    const spy = vi.spyOn(ImapFetchService.prototype, 'fetchSince').mockResolvedValue([
      {
        uid: 1,
        fromAddress: 'kees@example.com',
        toAddress: 'klantenservice@favotrip.nl',
        subject: 'Vraag over mijn boeking',
        body: 'Kan iemand mij helpen?',
        date: new Date('2026-05-22T10:10:00Z'),
      },
    ]);

    const runner = new DigestRunner({
      cfg,
      secrets: new FakeSecrets(),
      slack,
      log: () => {},
    });

    await runner.runOnce(new Date('2026-05-22T10:11:00Z'));
    expect(slack.posted.length).toBe(1);
    spy.mockRestore();
  });
});
