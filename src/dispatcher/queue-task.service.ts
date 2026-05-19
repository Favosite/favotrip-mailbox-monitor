import type { ProcessedMail } from '../types.js';

/**
 * Queue-task dispatcher (Tier-2 #6 of Worker hardening plan).
 *
 * Posts HIGH-priority mails to the centralised backend primitive
 * `POST /monitor/queue-task` (see Favosite/site-backend#749). The
 * endpoint records the dedupe + rate-limit decision; the actual
 * SSH-to-Worker dispatch keeps living in slack-watcher's
 * remote-dispatch.sh until a later centralisation pass.
 *
 * Failure handling:
 *   - Endpoint 5xx / network failure -> log + continue. The mailbox
 *     digest still posts (separate code path) so a human still sees
 *     the mail. We never throw out of this service.
 *   - Endpoint 4xx (validation) -> log + continue. Same rationale; do
 *     not let a malformed payload crash a 5-minute mailbox cycle.
 *   - duplicate=true / rateLimited=true -> log at info-level. Expected
 *     happy paths, not errors.
 *
 * Dedupe key is the IMAP uid (already a per-message immutable id in
 * Gmail's All Mail). Same value for taskId so the dispatch_log row is
 * self-referential. If we later need per-conversation dedupe (e.g.
 * reply-chains), we'll extend `ProcessedMail` with a thread_id.
 */
export interface QueueTaskConfig {
  url: string;
  apiKey: string;
  timeoutMs: number;
}

export interface QueueTaskBatchResult {
  total: number;
  attempted: number;
  queued: number;
  duplicates: number;
  rateLimited: number;
  errors: number;
}

interface QueueTaskResponseBody {
  taskId?: string;
  queued?: boolean;
  duplicate?: boolean;
  rateLimited?: boolean;
  reason?: string;
}

export class QueueTaskDispatcher {
  constructor(
    private readonly cfg: QueueTaskConfig,
    private readonly log: (
      level: 'info' | 'warn' | 'error',
      msg: string,
      meta?: Record<string, unknown>,
    ) => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async dispatchHighPriority(
    processed: ProcessedMail[],
  ): Promise<QueueTaskBatchResult> {
    const high = processed.filter((m) => m.priority === 'HIGH');
    const result: QueueTaskBatchResult = {
      total: processed.length,
      attempted: high.length,
      queued: 0,
      duplicates: 0,
      rateLimited: 0,
      errors: 0,
    };

    for (const mail of high) {
      try {
        const decision = await this.dispatchOne(mail);
        if (decision.rateLimited) {
          result.rateLimited += 1;
        } else if (decision.duplicate) {
          result.duplicates += 1;
        } else {
          result.queued += 1;
        }
      } catch (err) {
        result.errors += 1;
        this.log('error', 'queue.task.dispatch.failed', {
          uid: mail.uid,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (high.length > 0) {
      this.log('info', 'queue.task.batch', { ...result });
    }
    return result;
  }

  private async dispatchOne(mail: ProcessedMail): Promise<{
    duplicate: boolean;
    rateLimited: boolean;
    queued: boolean;
    reason: string;
  }> {
    // taskId pattern matches the regex in
    // src/monitor/dto/queue-task.dto.ts: mail-<4-80 alnum/_/-> chars.
    // ProcessedMail.uid is a number (IMAP UID); stringify + strip
    // anything fancier defensively in case the type widens later.
    const safeUid = String(mail.uid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    const taskId = `mail-${safeUid}`;
    const dedupeKey = taskId;

    // Payload carries enough context for the Worker to triage the mail
    // WITHOUT including PII (the body is masked in pii-mask service
    // already; we send masked_subject + bucket + flags only).
    //
    // The Worker fetches the full mail body at run-time via the
    // mailbox-monitor's HTTP read endpoint (not yet built; placeholder
    // for K1 follow-up). Until then, the digest's masked snippet is
    // the only body excerpt available.
    const body = {
      taskId,
      source: 'mail' as const,
      dedupeKey,
      priority: 'high' as const,
      payload: {
        uid: mail.uid,
        from_hash: mail.fromHash,
        masked_subject: mail.maskedSubject,
        bucket: mail.bucket,
        confidence: mail.confidence,
        flags: mail.flags,
        manual_only: mail.manualOnly,
        reservation_code: mail.reservationCode,
        date: mail.date.toISOString(),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.cfg.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-monitor-api-key': this.cfg.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(
        `queue-task endpoint returned HTTP ${String(response.status)}`,
      );
    }

    const json = (await response.json()) as QueueTaskResponseBody;
    return {
      duplicate: json.duplicate === true,
      rateLimited: json.rateLimited === true,
      queued: json.queued === true,
      reason: typeof json.reason === 'string' ? json.reason : '',
    };
  }
}
