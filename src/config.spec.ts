import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const BASE = {
  IMAP_USERNAME: 'klantenservice@favotrip.nl',
  IMAP_HOST: 'imap.example.com',
  IMAP_PORT: '993',
  IMAP_SECRET_ID: 'favotrip/mailbox-monitor/imap',
  AWS_REGION: 'eu-west-1',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
  HASH_SALT: 'a-long-enough-salt',
};

describe('loadConfig', () => {
  it('parses a valid env', () => {
    const cfg = loadConfig(BASE as unknown as NodeJS.ProcessEnv);
    expect(cfg.IMAP_USERNAME).toBe('klantenservice@favotrip.nl');
    expect(cfg.IMAP_PORT).toBe(993);
    expect(cfg.CRON_SCHEDULE).toBe('*/5 * * * *');
    expect(cfg.DRY_RUN).toBe(false);
  });

  it('rejects non-klantenservice IMAP_USERNAME', () => {
    expect(() =>
      loadConfig({ ...BASE, IMAP_USERNAME: 'someone@favotrip.nl' } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('rejects bad SLACK_WEBHOOK_URL', () => {
    expect(() =>
      loadConfig({ ...BASE, SLACK_WEBHOOK_URL: 'not-a-url' } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('rejects too-short HASH_SALT', () => {
    expect(() => loadConfig({ ...BASE, HASH_SALT: 'short' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('parses DRY_RUN truthy values', () => {
    expect(loadConfig({ ...BASE, DRY_RUN: 'true' } as NodeJS.ProcessEnv).DRY_RUN).toBe(true);
    expect(loadConfig({ ...BASE, DRY_RUN: '1' } as NodeJS.ProcessEnv).DRY_RUN).toBe(true);
    expect(loadConfig({ ...BASE, DRY_RUN: 'false' } as NodeJS.ProcessEnv).DRY_RUN).toBe(false);
  });
});
