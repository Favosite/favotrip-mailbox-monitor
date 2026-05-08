import { RepeatedMailerStore } from './classifier/repeated-mailer.service.js';
import type { Config } from './config.js';
import { buildDigestMessage } from './digest/digest.service.js';
import type { SlackPoster } from './digest/slack.service.js';
import { ImapFetchService } from './imap/imap.service.js';
import { processMails } from './pipeline.js';
import type { SecretsClient } from './secrets/secrets.service.js';
import { LastRunStore } from './state/last-run.service.js';

export interface RunnerDeps {
  cfg: Config;
  secrets: SecretsClient;
  slack: SlackPoster;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export class DigestRunner {
  private readonly state: LastRunStore;
  private readonly hashStore: RepeatedMailerStore;
  private readonly log: NonNullable<RunnerDeps['log']>;

  constructor(private readonly deps: RunnerDeps) {
    this.state = new LastRunStore(deps.cfg.STATE_FILE);
    this.hashStore = new RepeatedMailerStore({
      filePath: deps.cfg.HASH_STORE_FILE,
      salt: deps.cfg.HASH_SALT,
      thresholdCount: deps.cfg.REPEATED_MAILER_THRESHOLD,
      windowDays: deps.cfg.REPEATED_MAILER_WINDOW_DAYS,
    });
    this.log = deps.log ?? defaultLog;
  }

  async runOnce(now: Date = new Date()): Promise<void> {
    await this.hashStore.load();
    const { lastFetchAt, lastZeroPostAt } = await this.state.read();
    this.log('info', 'cycle.start', { lastFetchAt: lastFetchAt.toISOString() });

    let raw;
    try {
      const creds = await this.deps.secrets.getImapCredentials(this.deps.cfg.IMAP_SECRET_ID);
      const fetcher = new ImapFetchService(creds);
      raw = await fetcher.fetchSince({ since: lastFetchAt });
    } catch (err) {
      this.log('error', 'imap.fetch.failed', { err: (err as Error).message });
      throw err;
    }

    const processed = processMails(raw, this.hashStore);
    let nextZeroPostAt = lastZeroPostAt;

    if (processed.length === 0) {
      const sinceLastZero =
        lastZeroPostAt === undefined
          ? Infinity
          : (now.getTime() - lastZeroPostAt.getTime()) / 60000;
      if (sinceLastZero >= this.deps.cfg.ZERO_MAIL_POST_INTERVAL_MIN) {
        await this.deps.slack.post(buildDigestMessage([], now));
        nextZeroPostAt = now;
      } else {
        this.log('info', 'zero.skip.rate.limited', { minSince: Math.round(sinceLastZero) });
      }
    } else {
      await this.deps.slack.post(buildDigestMessage(processed, now));
    }

    this.hashStore.prune(now);
    await this.hashStore.save();
    await this.state.write({ lastFetchAt: now, lastZeroPostAt: nextZeroPostAt });
    this.log('info', 'cycle.end', { processed: processed.length });
  }
}

function defaultLog(
  level: 'info' | 'warn' | 'error',
  msg: string,
  meta?: Record<string, unknown>,
): void {
  // Structured log line — no PII ever passes through here. The msg + meta are operational only.
  const payload = { ts: new Date().toISOString(), level, msg, ...meta };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}
