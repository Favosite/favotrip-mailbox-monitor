import { z } from 'zod';

const ConfigSchema = z.object({
  IMAP_USERNAME: z
    .string()
    .refine(
      (v) => v === 'klantenservice@favotrip.nl',
      'IMAP_USERNAME must be klantenservice@favotrip.nl — this monitor is hard-locked to that single mailbox',
    ),
  IMAP_HOST: z.string().min(1),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_MAILBOX: z.string().min(1).default("[Gmail]/All Mail"),
  IMAP_SECRET_ID: z.string().min(1),
  AWS_REGION: z.string().default('eu-west-1'),
  SLACK_WEBHOOK_URL: z.string().url(),
  SLACK_CHANNEL: z.string().default('#team'),
  CRON_SCHEDULE: z.string().default('*/5 * * * *'),
  STATE_FILE: z.string().default('/var/lib/mailbox-monitor/state.json'),
  HASH_STORE_FILE: z.string().default('/var/lib/mailbox-monitor/sender-hashes.json'),
  HASH_SALT: z.string().min(8),
  /**
   * How often (minutes) to post a zero-mail notice to #team when no new
   * mail has arrived. Omit (or leave unset) to disable zero-mail posts
   * entirely — the default is OFF. Only set this if operators explicitly
   * want periodic "mailbox quiet" confirmations.
   *
   * Rationale: zero-mail notices were originally opt-in but the default of
   * 60 min caused noise in #team during quiet periods. Making it opt-in
   * matches the interrupt-policy spirit: only interrupt when there is
   * something actionable.
   */
  ZERO_MAIL_POST_INTERVAL_MIN: z.coerce.number().int().positive().optional(),
  REPEATED_MAILER_THRESHOLD: z.coerce.number().int().positive().default(3),
  REPEATED_MAILER_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Queue-task dispatch (Tier-2 #6 of Worker hardening plan). When all
  // three vars are set, HIGH-priority mails (priority='HIGH') are POSTed
  // to the centralised backend dispatch primitive POST /monitor/queue-task
  // (see Favosite/site-backend#749). Endpoint records dedupe + rate-limit
  // decisions; the actual SSH-to-Worker dispatch keeps living in
  // slack-watcher's remote-dispatch.sh until later migration.
  //
  // Digest posting is unaffected. Even when queue-task is enabled, the
  // digest still goes to #team so a human sees every mail (HIGH or
  // NORMAL). The endpoint is additive, not a replacement.
  //
  // Leave QUEUE_TASK_URL unset to disable; the runner skips the dispatch
  // step entirely. This lets us ship the code, deploy it, then flip the
  // env flag once the backend PR is in prod and verified.
  QUEUE_TASK_URL: z.string().url().optional(),
  QUEUE_TASK_API_KEY: z.string().min(1).optional(),
  QUEUE_TASK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // Phase-3 keyword classifier (Dennis 2026-05-21). When set, P0/P1
  // keyword hits get posted to this channel via the same backend
  // /monitor/slack-notify endpoint the digest uses (SLACK_BACKEND_URL +
  // SLACK_API_KEY are reused). Leave unset to disable keyword alerts —
  // the digest behaviour is unchanged.
  SLACK_CHANNEL_ALERTS: z.string().optional(),
  /** Dedupe state file for keyword alerts. Same volume as state.json. */
  KEYWORD_DEDUPE_FILE: z
    .string()
    .default('/var/lib/mailbox-monitor/keyword-dedupe.json'),

  // LOW-priority suppression (Dennis 2026-05-22 standing-mandate fix).
  // When a 5-min batch contains only LOW-suppressible mails (priority=NORMAL,
  // no keywordHit, no flags, not manual-only), the runner skips the
  // immediate #team digest post and instead rolls counts into this state
  // file for visibility in the 09:00 morning digest. HIGH/P0/P1 paths are
  // unchanged. See src/digest/priority-gate.ts for the predicate.
  SUPPRESSED_COUNTS_FILE: z
    .string()
    .default('/var/lib/mailbox-monitor/suppressed-counts.json'),
  /**
   * Disable LOW-priority suppression and restore pre-fix behaviour
   * (every non-empty batch posts to #team). Default false — suppression is
   * the new normal. Set to 'true'/'1' to revert.
   */
  SUPPRESS_LOW_PRIORITY_DISABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  /**
   * Disable the new interrupt-policy gate (interrupt-policy.ts) and fall
   * back to the PR #10 isAllLowPriority gate. Use this if the new gate
   * starts mis-classifying real urgent traffic as routine; the runner
   * will revert to the previous (more permissive) suppression rule
   * without a redeploy. Default false — interrupt-policy is the new
   * normal as of Dennis 2026-05-22 second iteration. Set to 'true'/'1'
   * to revert.
   *
   * Hierarchy: SUPPRESS_LOW_PRIORITY_DISABLED dominates and reverts
   * ALL the way to pre-PR-#10 (every non-empty batch posts). When that
   * is false but INTERRUPT_GATE_DISABLED is true, runner falls back to
   * the PR #10 isAllLowPriority gate. When both are false (default),
   * the new interrupt-policy gate runs.
   */
  INTERRUPT_GATE_DISABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  /**
   * Daily rollup cron expression. Posts a one-line summary of yesterday's
   * LOW-priority suppressed counts to #team. Default 0 8 * * * UTC =
   * 09:00 Europe/Amsterdam year-round (Dennis prefers no-DST clock).
   *
   * Set to empty string to disable the daily rollup entirely (suppressed
   * counts will then live only in SUPPRESSED_COUNTS_FILE, visible only by
   * direct inspection).
   */
  DAILY_ROLLUP_CRON: z.string().default('0 8 * * *'),

  /**
   * Owner-post cooldown state file. Tracks the timestamp of the last
   * top-level #team mailbox-action post per owner UID so the runner
   * can collapse multiple urgent batches within the cooldown window
   * into one post. Dennis 2026-05-23 third iteration.
   */
  OWNER_POST_COOLDOWN_FILE: z
    .string()
    .default('/var/lib/mailbox-monitor/owner-post-cooldown.json'),

  /**
   * Cooldown in minutes between top-level #team mailbox-action posts
   * for the same owner. P0/P1 keyword hits bypass the cooldown
   * (customer impact > dedup noise). Default 60 minutes per Dennis
   * 2026-05-23 spec.
   */
  MAILBOX_OWNER_COOLDOWN_MIN: z
    .string()
    .default('60')
    .transform((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 60;
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
