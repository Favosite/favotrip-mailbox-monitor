import { RepeatedMailerStore } from './classifier/repeated-mailer.service.js';
import type { Config } from './config.js';
import { buildDigestMessage } from './digest/digest.service.js';
import {
  KeywordAlertService,
  KeywordDedupeStore,
} from './digest/keyword-alert.service.js';
import {
  classifyForSuppression,
  classifyInterrupt,
  isAllRoutine,
} from './digest/interrupt-policy.js';
import { isAllLowPriority } from './digest/priority-gate.js';
import type { SlackPoster } from './digest/slack.service.js';
import { QueueTaskDispatcher } from './dispatcher/queue-task.service.js';
import { ImapFetchService } from './imap/imap.service.js';
import { processMails } from './pipeline.js';
import type { SecretsClient } from './secrets/secrets.service.js';
import { LastRunStore } from './state/last-run.service.js';
import { SuppressedCountsStore } from './state/suppressed-counts.service.js';
import type { ProcessedMail } from './types.js';

export interface RunnerDeps {
  cfg: Config;
  secrets: SecretsClient;
  slack: SlackPoster;
  /**
   * Optional separate poster for Phase-3 keyword alerts (#alerts).
   * When omitted but cfg.SLACK_CHANNEL_ALERTS is set, the runner falls
   * back to `slack` (single-channel dev case). Production wires this
   * explicitly to a BackendApiPoster pointing at the #alerts channelId.
   */
  alertsSlack?: SlackPoster;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export class DigestRunner {
  private readonly state: LastRunStore;
  private readonly hashStore: RepeatedMailerStore;
  private readonly suppressedCounts: SuppressedCountsStore;
  private readonly log: NonNullable<RunnerDeps['log']>;
  private readonly dispatcher: QueueTaskDispatcher | null;
  private readonly keywordAlerts: {
    service: KeywordAlertService;
    store: KeywordDedupeStore;
  } | null;

  constructor(private readonly deps: RunnerDeps) {
    this.state = new LastRunStore(deps.cfg.STATE_FILE);
    this.suppressedCounts = new SuppressedCountsStore(deps.cfg.SUPPRESSED_COUNTS_FILE);
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

    // Phase-3 keyword classifier (Dennis 2026-05-21). Enabled when
    // SLACK_CHANNEL_ALERTS is set AND an alertsSlack poster is wired
    // (or we fall back to the digest poster for dev/test).
    if (deps.cfg.SLACK_CHANNEL_ALERTS) {
      const poster = deps.alertsSlack ?? deps.slack;
      const store = new KeywordDedupeStore(deps.cfg.KEYWORD_DEDUPE_FILE);
      const service = new KeywordAlertService({
        poster,
        store,
        salt: deps.cfg.HASH_SALT,
        log: this.log,
      });
      this.keywordAlerts = { service, store };
      this.log('info', 'keyword.alerts.enabled', {
        channel: deps.cfg.SLACK_CHANNEL_ALERTS,
      });
    } else {
      this.keywordAlerts = null;
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
      const intervalMin = this.deps.cfg.ZERO_MAIL_POST_INTERVAL_MIN;
      if (intervalMin === undefined) {
        this.log('info', 'zero.skip.disabled');
      } else {
        const sinceLastZero =
          lastZeroPostAt === undefined
            ? Infinity
            : (now.getTime() - lastZeroPostAt.getTime()) / 60000;
        if (sinceLastZero >= intervalMin) {
          const zeroText = buildDigestMessage([], now);
          if (zeroText) {
            await this.deps.slack.post(zeroText);
          } else {
            // 2026-05-23: buildDigestMessage([]) now returns "" by
            // policy. We honour ZERO_MAIL_POST_INTERVAL_MIN's intent
            // (mark the cycle so we don't reconsider next tick) but
            // never send the empty body to #team.
            this.log('info', 'zero.heartbeat.suppressed');
          }
          nextZeroPostAt = now;
        } else {
          this.log('info', 'zero.skip.rate.limited', { minSince: Math.round(sinceLastZero) });
        }
      }
    } else if (shouldSuppressBatch(processed, this.deps.cfg)) {
      // Suppression rule chosen by config:
      //   SUPPRESS_LOW_PRIORITY_DISABLED=true → never suppress (pre-PR-#10)
      //   INTERRUPT_GATE_DISABLED=true        → PR #10 isAllLowPriority
      //   default                             → interrupt-policy gate
      //
      // The decision lives in shouldSuppressBatch() so the runner stays
      // readable. Per-mail reasons are persisted to the suppressed-counts
      // state file so the 09:00 rollup can surface WHY each mail was
      // suppressed (repeated_mailer_only, needs_human_review_nonurgent,
      // low_priority, other_routine).
      const classified = classifyForSuppression(processed);
      await this.suppressedCounts.load();
      this.suppressedCounts.add(classified, now);
      this.suppressedCounts.prune(now);
      await this.suppressedCounts.save();
      this.log('info', 'digest.skipped.all-routine', {
        count: processed.length,
        bucketCounts: countBuckets(processed),
        reasonCounts: countReasons(classified),
        gate: this.deps.cfg.INTERRUPT_GATE_DISABLED
          ? 'isAllLowPriority(legacy)'
          : 'isAllRoutine(interrupt-policy)',
      });
    } else {
      // Either a fall-back env is set, OR at least one mail in the
      // batch is interrupt-worthy. Log per-mail decisions for
      // observability (no PII — only bucket + reason + detail strings,
      // which never include raw subject/body content).
      const decisions = processed.map((m) => ({
        bucket: m.bucket,
        decision: classifyInterrupt(m),
      }));
      this.log('info', 'digest.post.interrupt-or-fallback', {
        count: processed.length,
        interruptCount: decisions.filter((d) => d.decision.interrupt).length,
        details: decisions.map((d) => ({
          bucket: d.bucket,
          interrupt: d.decision.interrupt,
          reason: d.decision.reason,
          detail: d.decision.detail,
        })),
      });
      const digestText = buildDigestMessage(processed, now);
      if (digestText) {
        await this.deps.slack.post(digestText);
      } else {
        // Defense-in-depth (Dennis 2026-05-23): buildDigestMessage
        // returns "" when there's nothing actionable to say. Never
        // post an empty body to #team. Detail stays in the structured
        // log emitted just above.
        this.log('info', 'digest.skipped.empty-render');
      }
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

    // Phase-3 keyword alerts (Dennis 2026-05-21). Posts P0/P1 to
    // #alerts (cfg.SLACK_CHANNEL_ALERTS). Dedupe state is persisted
    // across runs so the same (severity, thread, day) doesn't re-fire.
    // Service swallows per-post errors so a Slack hiccup doesn't kill
    // the cycle.
    if (this.keywordAlerts && processed.length > 0) {
      await this.keywordAlerts.store.load();
      this.keywordAlerts.store.prune(now);
      const r = await this.keywordAlerts.service.flush(processed, now);
      await this.keywordAlerts.store.save();
      this.log('info', 'keyword.alerts.flushed', {
        emitted: r.emitted,
        skippedDedupe: r.skippedDedupe,
        errors: r.errors,
      });
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

function countBuckets(mails: ReadonlyArray<{ bucket: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of mails) {
    out[m.bucket] = (out[m.bucket] ?? 0) + 1;
  }
  return out;
}

function countReasons(
  items: ReadonlyArray<{ reason: string }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    out[it.reason] = (out[it.reason] ?? 0) + 1;
  }
  return out;
}

/**
 * Decide whether the whole batch should be suppressed (no #team post).
 *
 * Hierarchy of env-flag fall-backs (Dennis 2026-05-22 second iteration):
 *   SUPPRESS_LOW_PRIORITY_DISABLED=true → never suppress (revert to pre-PR-#10)
 *   INTERRUPT_GATE_DISABLED=true        → fall back to PR #10 isAllLowPriority
 *   default                             → new interrupt-policy isAllRoutine
 */
function shouldSuppressBatch(
  processed: ProcessedMail[],
  cfg: { SUPPRESS_LOW_PRIORITY_DISABLED?: boolean; INTERRUPT_GATE_DISABLED?: boolean },
): boolean {
  if (cfg.SUPPRESS_LOW_PRIORITY_DISABLED) return false;
  if (cfg.INTERRUPT_GATE_DISABLED) return isAllLowPriority(processed);
  return isAllRoutine(processed);
}
