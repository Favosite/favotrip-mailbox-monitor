import { RepeatedMailerStore } from './classifier/repeated-mailer.service.js';
import type { Config } from './config.js';
import { buildDigestMessage } from './digest/digest.service.js';
import type { SlackPoster } from './digest/slack.service.js';
import { QueueTaskDispatcher } from './dispatcher/queue-task.service.js';
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
  private readonly dispatcher: QueueTaskDispatcher | null;

  constructor(private readonly deps: RunnerDeps) {
    this.state = new LastRunStore(deps.cfg.STATE_FILE);
    this.hashStore = new RepeatedMailerStore({
      filePath: deps.cfg.HASH_STORE_FILE,
      salt: deps.cfg.HASH_SALT,
      thresholdCount: deps.cfg.REPEATED_MAILER_THRESHOLD,
      windowDays: deps.cfg.REPEATED_MAILER_WINDOW_DAYS,
    });
    this.log = deps.log ?? defaultLog;

    // Queue-task dispatch (Tier-2 #6). Enabled only when both
    // QUEUE_TASK_URL and QUEUE_TASK_API_KEY env vars are set. Lets us
    // ship the code, deploy it, and flip the flag without redeploying.
    if (deps.cfg.QUEUE_TASK_URL && deps.cfg.QUEUE_TASK_API_KEY) {
      this.dispatcher = new QueueTaskDispatcher(
        {
          url: deps.cfg.QUEUE_TASK_URL,
          apiKey: deps.cfg.QUEUE_TASK_API_KEY,
          timeoutMs: deps.cfg.QUEUE_TASK_TIMEOUT_MS,
        },
        this.log,
      );
      this.log('info', 'queue.task.enabled', { url: deps.cfg.QUEUE_TASK_URL });
    } else {
      this.dispatcher = null;
    }
  }

  async runOnce(now: Date = new Date()): Promise<void> {
    await this.hashStore.load();
    const { lastFetchAt, lastZeroPostAt } = await this.state.read();
    this.log('info', 'cycle.start', { lastFetchAt: lastFetchAt.toISOString() });

    let raw;
    try {
      const creds = await this.deps.secrets.getImapCredentials(this.deps.cfg.IMAP_SECRET_ID);
      const fetcher = new ImapFetchService(creds);
      raw = await fetcher.fetchSince({ since: lastFetchAt, mailbox: this.deps.cfg.IMAP_MAILBOX });
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

    // Tier-2 #6: dispatch HIGH-priority mails to the centralised
    // queue-task endpoint after the digest post. The digest is the
    // primary human-visibility surface; the queue-task call is the
    // Worker-routing surface. Both run, neither blocks the other.
    // Dispatcher swallows errors internally so a backend hiccup does
    // not crash the mailbox cycle.
    if (this.dispatcher && processed.length > 0) {
      await this.dispatcher.dispatchHighPriority(processed);
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
