import cron from 'node-cron';
import { loadConfig } from './config.js';
import { ConsoleLogPoster, SlackWebhookPoster, type SlackPoster } from './digest/slack.service.js';
import { AwsSecretsClient } from './secrets/secrets.service.js';
import { DigestRunner } from './runner.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

  const slack: SlackPoster = cfg.DRY_RUN
    ? new ConsoleLogPoster()
    : new SlackWebhookPoster(cfg.SLACK_WEBHOOK_URL, cfg.SLACK_CHANNEL);
  const secrets = new AwsSecretsClient(cfg.AWS_REGION);

  const runner = new DigestRunner({ cfg, secrets, slack });

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
