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
    // ZERO_MAIL_POST_INTERVAL_MIN intentionally omitted — default is OFF
    REPEATED_MAILER_THRESHOLD: 3,
    REPEATED_MAILER_WINDOW_DAYS: 7,
    DRY_RUN: true,
    LOG_LEVEL: 'info',
    QUEUE_TASK_TIMEOUT_MS: 10000,
    KEYWORD_DEDUPE_FILE: path.join(dir, 'keyword-dedupe.json'),
    SUPPRESSED_COUNTS_FILE: path.join(dir, 'suppressed-counts.json'),
    SUPPRESS_LOW_PRIORITY_DISABLED: false,
    INTERRUPT_GATE_DISABLED: false,
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
  it('zero-mail post is disabled by default (ZERO_MAIL_POST_INTERVAL_MIN unset)', async () => {
    const cfg = mkCfg(); // ZERO_MAIL_POST_INTERVAL_MIN not set → disabled
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

    // Run multiple times — zero-mail posts must never fire when interval is unset
    await runner.runOnce(new Date('2026-05-22T10:00:00Z'));
    await runner.runOnce(new Date('2026-05-22T10:05:00Z'));
    await runner.runOnce(new Date('2026-05-22T11:00:00Z'));
    expect(slack.posted.length).toBe(0);

    spy.mockRestore();
  });

  it('zero-mail heartbeat is fully suppressed (2026-05-23 spec): never posts to #team', async () => {
    // Old behavior: ZERO_MAIL_POST_INTERVAL_MIN=60 → post "0 mails" once
    // per hour. New behavior: buildDigestMessage([]) returns "" and the
    // runner skips the post entirely. The rate-limit timestamp still
    // advances so we don't re-evaluate every tick.
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

    await runner.runOnce(new Date('2026-05-08T10:00:00Z'));
    await runner.runOnce(new Date('2026-05-08T10:30:00Z'));
    await runner.runOnce(new Date('2026-05-08T11:01:00Z'));
    expect(slack.posted.length).toBe(0);

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
    expect(slack.posted[0]).toMatch(/^<@U07TM7DKMUF> ACTION: behandel \d+ klantmail/);
    expect(slack.posted[0]).not.toContain('cancellation_request'); // doctrine: no bucket leak
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
    expect(slack.posted[0]).toMatch(/^<@U07TM7DKMUF> ACTION: behandel \d+ klantmail/);
    expect(slack.posted[0]).toContain('HIGH');
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
    expect(teamSlack.posted[0]).toMatch(/^<@U07TM7DKMUF> ACTION: behandel \d+ klantmail/);
    spy.mockRestore();
  });

  it('zero-mail heartbeat is fully suppressed even when ZERO_MAIL_POST_INTERVAL_MIN is set', async () => {
    // 2026-05-23: buildDigestMessage([]) returns "" → runner skips the
    // post regardless of the rate-limit interval. The interval timestamp
    // still advances internally but no Slack post fires.
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

    await runner.runOnce(new Date('2026-05-22T10:00:00Z'));
    await runner.runOnce(new Date('2026-05-22T11:01:00Z'));
    expect(slack.posted.length).toBe(0);

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

  // ────────────────────────────────────────────────────────────────
  // Interrupt-policy gate scenarios (Dennis 2026-05-22 2nd iteration)
  // ────────────────────────────────────────────────────────────────

  async function runWithImap(
    cfg: Config,
    raws: ConstructorParameters<typeof Date>[0] extends never ? never : Array<{
      uid: number;
      fromAddress: string;
      toAddress: string;
      subject: string;
      body: string;
      date: Date;
    }>,
    slack: CapturePoster,
  ): Promise<void> {
    const { ImapFetchService } = await import('./imap/imap.service.js');
    const spy = vi.spyOn(ImapFetchService.prototype, 'fetchSince').mockResolvedValue(raws);
    const runner = new DigestRunner({
      cfg,
      secrets: new FakeSecrets(),
      slack,
      log: () => {},
    });
    await runner.runOnce(new Date('2026-05-22T15:00:00Z'));
    spy.mockRestore();
  }

  it('Scenario 2: booking_question HIGH driven ONLY by repeated_mailer → suppressed (NOT posted)', async () => {
    const cfg = mkCfg();
    const slack = new CapturePoster();
    // Pre-seed the hash store so this address counts as a repeated mailer
    // (threshold default = 3 within 7 days). The simplest way: send 3 mails
    // with the same fromAddress; the 3rd one will have repeated_mailer flag.
    const sameSender = 'repeat@example.com';
    await runWithImap(cfg, [
      { uid: 1, fromAddress: sameSender, toAddress: 'klantenservice@favotrip.nl',
        subject: 'vraag 1', body: 'eerste vraag', date: new Date('2026-05-22T14:00:00Z') },
      { uid: 2, fromAddress: sameSender, toAddress: 'klantenservice@favotrip.nl',
        subject: 'vraag 2', body: 'tweede vraag', date: new Date('2026-05-22T14:30:00Z') },
      { uid: 3, fromAddress: sameSender, toAddress: 'klantenservice@favotrip.nl',
        subject: 'vraag 3', body: 'derde vraag', date: new Date('2026-05-22T15:00:00Z') },
    ], slack);
    // All 3 are booking_question with the 3rd having repeated_mailer.
    // 1+2 are routine LOW, 3rd is HIGH-by-repeated_mailer-only.
    // Per new policy: NONE interrupt-worthy → batch suppressed.
    expect(slack.posted.length).toBe(0);
  });

  it('Scenario 3: needs_human_review without urgent keyword → suppressed (NEW behaviour)', async () => {
    const cfg = mkCfg();
    const slack = new CapturePoster();
    await runWithImap(cfg, [
      { uid: 1, fromAddress: 'kort@example.com', toAddress: 'klantenservice@favotrip.nl',
        subject: 'hoi',
        body: 'a',  // Very short body → classifier should output needs_human_review
        date: new Date('2026-05-22T15:00:00Z') },
    ], slack);
    expect(slack.posted.length).toBe(0);
  });

  it('Scenario 5: needs_human_review WITH "betaling lukt niet" keyword → directly posted', async () => {
    const cfg = mkCfg();
    const slack = new CapturePoster();
    await runWithImap(cfg, [
      { uid: 1, fromAddress: 'a@example.com', toAddress: 'klantenservice@favotrip.nl',
        subject: 'hulp',
        body: 'b betaling lukt niet b',  // urgent keyword in body
        date: new Date('2026-05-22T15:00:00Z') },
    ], slack);
    expect(slack.posted.length).toBe(1);
  });

  it('Scenario 6: booking_question WITH "voucher werkt niet" keyword → directly posted', async () => {
    const cfg = mkCfg();
    const slack = new CapturePoster();
    await runWithImap(cfg, [
      { uid: 1, fromAddress: 'klant@example.com', toAddress: 'klantenservice@favotrip.nl',
        subject: 'mijn boeking voor volgende week',
        body: 'Hallo, ik probeer in te checken maar mijn voucher werkt niet, kan iemand kijken?',
        date: new Date('2026-05-22T15:00:00Z') },
    ], slack);
    expect(slack.posted.length).toBe(1);
    expect(slack.posted[0]).toMatch(/^<@U07TM7DKMUF> ACTION: behandel \d+ klantmail/);
  });

  it('Scenario 7: cancellation_request → directly posted (compliant owner-tagged message)', async () => {
    const cfg = mkCfg();
    const slack = new CapturePoster();
    await runWithImap(cfg, [
      { uid: 1, fromAddress: 'cancel@example.com', toAddress: 'klantenservice@favotrip.nl',
        subject: 'Annulering FT-AB-CD-EF',
        body: 'Wij willen onze boeking annuleren wegens ziekte.',
        date: new Date('2026-05-22T15:00:00Z') },
    ], slack);
    expect(slack.posted.length).toBe(1);
    expect(slack.posted[0]).toMatch(/^<@U07TM7DKMUF> ACTION: behandel \d+ klantmail/);
    expect(slack.posted[0]).not.toContain('cancellation_request'); // doctrine: no bucket leak
  });

  it('Scenario 10: legal_threat flag → directly posted', async () => {
    const cfg = mkCfg();
    const slack = new CapturePoster();
    await runWithImap(cfg, [
      { uid: 1, fromAddress: 'jurist@example.com', toAddress: 'klantenservice@favotrip.nl',
        subject: 'sommatie betreffende uw dienst',
        body: 'Bij gebreke van een passende reactie schakel ik per ommegaande een advocaat in. Tevens overweeg ik aangifte bij de ACM.',
        date: new Date('2026-05-22T15:00:00Z') },
    ], slack);
    expect(slack.posted.length).toBe(1);
    expect(slack.posted[0]).toMatch(/HIGH|legal_threat/);
  });

  it('Scenario: INTERRUPT_GATE_DISABLED reverts to PR #10 (isAllLowPriority) — needs_human_review now posts again', async () => {
    const cfg = mkCfg({ INTERRUPT_GATE_DISABLED: true });
    const slack = new CapturePoster();
    await runWithImap(cfg, [
      { uid: 1, fromAddress: 'kort@example.com', toAddress: 'klantenservice@favotrip.nl',
        subject: 'hoi', body: 'a', date: new Date('2026-05-22T15:00:00Z') },
    ], slack);
    // Under PR #10 logic, needs_human_review was NOT in LOW_BUCKETS,
    // so this would NOT be suppressed → posted.
    expect(slack.posted.length).toBe(1);
  });

  it('Scenario: suppressed counts include reason codes (rollup readout)', async () => {
    const cfg = mkCfg();
    const slack = new CapturePoster();
    await runWithImap(cfg, [
      { uid: 1, fromAddress: 'a@example.com', toAddress: 'klantenservice@favotrip.nl',
        subject: 'vraag', body: 'wanneer kan ik incheckenz?', date: new Date('2026-05-22T15:00:00Z') },
      { uid: 2, fromAddress: 'kort@example.com', toAddress: 'klantenservice@favotrip.nl',
        subject: 'hoi', body: 'a', date: new Date('2026-05-22T15:00:00Z') },
    ], slack);
    expect(slack.posted.length).toBe(0);
    const raw = await fs.readFile(cfg.SUPPRESSED_COUNTS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, {
      totalSuppressed: number;
      byBucket: Record<string, number>;
      byReason: Record<string, number>;
    }>;
    const day = parsed['2026-05-22'];
    expect(day.totalSuppressed).toBe(2);
    expect(day.byReason).toBeDefined();
    // At least one of low_priority or needs_human_review_nonurgent must be present
    const reasonKeys = Object.keys(day.byReason);
    expect(reasonKeys.length).toBeGreaterThan(0);
    expect(
      reasonKeys.some((r) =>
        ['low_priority', 'needs_human_review_nonurgent', 'other_routine'].includes(r),
      ),
    ).toBe(true);
  });
});
