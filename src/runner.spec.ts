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
});
