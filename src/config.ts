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
  ZERO_MAIL_POST_INTERVAL_MIN: z.coerce.number().int().positive().default(60),
  REPEATED_MAILER_THRESHOLD: z.coerce.number().int().positive().default(3),
  REPEATED_MAILER_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
