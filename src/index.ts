import cron from 'node-cron';
import { loadConfig } from './config.js';
import { BackendApiPoster, ConsoleLogPoster, SlackWebhookPoster, type SlackPoster } from './digest/slack.service.js';
import { AwsSecretsClient, EnvSecretsClient, type SecretsClient } from './secrets/secrets.service.js';
import { DigestRunner } from './runner.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

  // 2026-05-18: prefer BackendApiPoster when SLACK_BACKEND_URL+API_KEY+CHANNEL_ID
  // are present (re-uses existing Favotrip /monitor/slack-notify endpoint, no
  // separate Slack-app/webhook needed). Falls back to webhook only when those
  // env vars are absent.
  let slack: SlackPoster;
  if (cfg.DRY_RUN) {
    slack = new ConsoleLogPoster();
  } else if (process.env.SLACK_BACKEND_URL && process.env.SLACK_API_KEY && process.env.SLACK_CHANNEL_ID) {
    slack = new BackendApiPoster(
      process.env.SLACK_BACKEND_URL,
      process.env.SLACK_API_KEY,
      process.env.SLACK_CHANNEL_ID,
    );
  } else {
    slack = new SlackWebhookPoster(cfg.SLACK_WEBHOOK_URL, cfg.SLACK_CHANNEL);
  }

  // Phase-3 keyword classifier (Dennis 2026-05-21). Separate poster
  // targeting #alerts (SLACK_CHANNEL_ALERTS). Reuses SLACK_BACKEND_URL +
  // SLACK_API_KEY from the digest path. In DRY_RUN mode falls through
  // to the same console poster (single visible stream).
  let alertsSlack: SlackPoster | undefined;
  if (cfg.DRY_RUN) {
    alertsSlack = slack;
  } else if (
    cfg.SLACK_CHANNEL_ALERTS &&
    process.env.SLACK_BACKEND_URL &&
    process.env.SLACK_API_KEY
  ) {
    alertsSlack = new BackendApiPoster(
      process.env.SLACK_BACKEND_URL,
      process.env.SLACK_API_KEY,
      cfg.SLACK_CHANNEL_ALERTS,
    );
  }

  // Secrets-client selection. AwsSecretsClient is the documented production path,
  // but the favotrip EC2 instance currently has no IAM role attached and follows
  // the .env-file pattern shared by every other service in docker-compose
  // (.env.backend, .env.frontend, .env.cms, .env.monitor — all hold their own
  // credentials). Aligning with that pattern: when DEV_IMAP_HOST is set, read
  // creds directly from env. AWS Secrets Manager remains the v2 path once an
  // instance role is provisioned.
  const secrets: SecretsClient = process.env.DEV_IMAP_HOST
    ? new EnvSecretsClient()
    : new AwsSecretsClient(cfg.AWS_REGION);

  const runner = new DigestRunner({ cfg, secrets, slack, alertsSlack });

  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'startup', cron: cfg.CRON_SCHEDULE }));

  const task = cron.schedule(cfg.CRON_SCHEDULE, () => {
    runner.runOnce().catch((err: Error) => {
      console.log(
        JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'runOnce.failed', err: err.message }),
      );
    });
  });

  // Run once at startup so we don't wait 5 min for first signal-of-life.
  runner.runOnce().catch((err: Error) => {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'startup.run.failed', err: err.message }),
    );
  });

  const shutdown = async (sig: string): Promise<void> => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'shutdown', sig }));
    task.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  console.error('fatal', err);
  process.exit(1);
});
