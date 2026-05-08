import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { ImapCredentials } from '../imap/imap.service.js';

export interface SecretsClient {
  getImapCredentials(secretId: string): Promise<ImapCredentials>;
}

export class AwsSecretsClient implements SecretsClient {
  private readonly client: SecretsManagerClient;

  constructor(region: string) {
    this.client = new SecretsManagerClient({ region });
  }

  async getImapCredentials(secretId: string): Promise<ImapCredentials> {
    const out = await this.client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!out.SecretString) {
      throw new Error(`SecretsManager: SecretString empty for ${secretId}`);
    }
    const parsed = JSON.parse(out.SecretString) as Partial<ImapCredentials>;
    if (!parsed.host || !parsed.port || !parsed.user || !parsed.password) {
      throw new Error('SecretsManager: missing required field (host/port/user/password)');
    }
    return {
      host: parsed.host,
      port: Number(parsed.port),
      user: parsed.user,
      password: parsed.password,
    };
  }
}

export class EnvSecretsClient implements SecretsClient {
  /** Test/dev fallback. Never use in prod — credentials in env are not allowed per spec. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getImapCredentials(_secretId: string): Promise<ImapCredentials> {
    const host = process.env.DEV_IMAP_HOST;
    const port = Number(process.env.DEV_IMAP_PORT ?? 993);
    const user = process.env.DEV_IMAP_USER;
    const password = process.env.DEV_IMAP_PASSWORD;
    if (!host || !user || !password) {
      throw new Error('EnvSecretsClient: DEV_IMAP_* env vars missing');
    }
    return { host, port, user, password };
  }
}
