import { IncomingWebhook } from '@slack/webhook';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { evaluate, type DoctrineDecision } from '../slack-doctrine/slack-doctrine.js';

export interface SlackPoster {
  post(text: string): Promise<void>;
}

export class SlackWebhookPoster implements SlackPoster {
  private readonly hook: IncomingWebhook;
  constructor(webhookUrl: string, private readonly channel: string) {
    this.hook = new IncomingWebhook(webhookUrl);
  }
  async post(text: string): Promise<void> {
    await this.hook.send({ text, channel: this.channel });
  }
}

export class ConsoleLogPoster implements SlackPoster {
  async post(text: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[slack-dry-run]\n' + text);
  }
}


/**
 * 2026-05-18: alternative poster that calls Favotrip backend's existing
 * /monitor/slack-notify endpoint (uses x-monitor-api-key auth + channelId).
 * Re-uses existing Slack-bot integration so we don't need a separate
 * incoming-webhook app. Activate via SLACK_BACKEND_URL + SLACK_API_KEY +
 * SLACK_CHANNEL_ID env vars (overrides SlackWebhookPoster).
 */
export class BackendApiPoster implements SlackPoster {
  constructor(
    private readonly backendUrl: string,
    private readonly apiKey: string,
    private readonly channelId: string,
  ) {}
  async post(text: string): Promise<void> {
    const res = await fetch(this.backendUrl + '/monitor/slack-notify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-monitor-api-key': this.apiKey,
      },
      body: JSON.stringify({ channelId: this.channelId, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error('backend slack-notify ' + String(res.status) + ': ' + body.slice(0, 200));
    }
  }
}


/**
 * 2026-05-25: DoctrineSlackPoster wraps any SlackPoster (typically a
 * BackendApiPoster for #team) with a 30-minute content cooldown and a
 * tech-refs guard. Mirrors server-claude-worker
 * `scripts/monitors/slack_post.py` doctrine.
 *
 * Wiring:
 *   - `inner`           — the original SlackPoster (e.g. BackendApiPoster
 *                         configured for #team)
 *   - `channelId`       — channel `inner` posts to (used to decide
 *                         whether policy checks apply; checks only fire for
 *                         CHANNEL_TEAM top-level posts)
 *   - `stateFile`       — JSON cooldown state file (mirror of Python
 *                         wrapper's slack-post-content-cooldown.json)
 *   - `auditFile`       — JSONL suppression-audit log; one line per
 *                         time a post was suppressed or blocked so
 *                         operators can grep history without a full
 *                         restart of the runner.
 *   - `now`             — injectable clock for tests (default Date.now)
 *
 * Failure modes:
 *   - SUPPRESSED / BLOCKED outcomes → suppression-audit row written,
 *     `post()` returns normally (no throw). Suppression IS success in
 *     the doctrine model — the post correctly did NOT land.
 *   - Inner `inner.post()` for the original text can throw; we re-throw
 *     so the caller sees the same error contract as a bare
 *     BackendApiPoster.
 */
export interface DoctrineSlackPosterOptions {
  inner: SlackPoster;
  channelId: string;
  stateFile: string;
  auditFile: string;
  now?: () => number;
  contentCooldownSec?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export class DoctrineSlackPoster implements SlackPoster {
  constructor(private readonly opts: DoctrineSlackPosterOptions) {}

  async post(text: string): Promise<void> {
    const decision = evaluate({
      channel: this.opts.channelId,
      text,
      stateFile: this.opts.stateFile,
      contentCooldownSec: this.opts.contentCooldownSec,
      now: this.opts.now,
    });

    // Decision: post = false → audit + return success (suppression IS success).
    if (!decision.post) {
      this.appendAudit({
        outcome: decision.status,
        channel: this.opts.channelId,
        dedupKey: decision.dedupKey,
        reason: decision.reason,
        textPreview: text.slice(0, 200),
      });
      this.opts.log?.('info', 'slack-doctrine.suppressed', {
        status: decision.status,
        channel: this.opts.channelId,
        dedupKey: decision.dedupKey,
      });
      return;
    }

    // Post the original text to the original channel. Re-throw on failure;
    // the caller's error contract is unchanged from a bare BackendApiPoster.
    await this.opts.inner.post(decision.text);
  }

  /** Append one JSONL row to the suppression-audit file. Best-effort
   *  on I/O errors so a missing-dir + unwritable path don't crash the
   *  hot Slack-post path. */
  private appendAudit(row: {
    outcome: string;
    channel: string;
    dedupKey?: string;
    reason: string;
    textPreview: string;
  }): void {
    try {
      mkdirSync(dirname(this.opts.auditFile), { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        ...row,
      });
      appendFileSync(this.opts.auditFile, line + '\n', 'utf-8');
    } catch (err) {
      // Don't throw from the audit path — observability is best-effort.
      this.opts.log?.('warn', 'slack-doctrine.audit.failed', {
        err: (err as Error).message,
      });
    }
  }
}

// Re-export DoctrineDecision so consumers can type their evaluate() result
// without an extra deep import.
export type { DoctrineDecision };
