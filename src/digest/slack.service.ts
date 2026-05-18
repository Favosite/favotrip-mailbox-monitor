import { IncomingWebhook } from '@slack/webhook';

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