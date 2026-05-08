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
