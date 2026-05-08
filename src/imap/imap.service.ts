import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { simpleParser } from 'mailparser';
import { wrapReadOnly } from './readonly-guard.js';
import type { RawMail } from '../types.js';

export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface FetchOptions {
  since: Date;
  /** Hard cap to avoid runaway fetches. */
  maxMessages?: number;
}

const RESERVATION_RE = /\bFT-[A-Z0-9]{2,4}(?:-[A-Z0-9]{2,4}){1,3}\b/;

export class ImapFetchService {
  private static readonly EXPECTED_USER = 'klantenservice@favotrip.nl';

  constructor(private readonly creds: ImapCredentials) {
    if (creds.user !== ImapFetchService.EXPECTED_USER) {
      throw new Error(
        `IMAP user lock violation: expected ${ImapFetchService.EXPECTED_USER}, got ${creds.user}`,
      );
    }
  }

  async fetchSince(opts: FetchOptions): Promise<RawMail[]> {
    const config: ImapFlowOptions = {
      host: this.creds.host,
      port: this.creds.port,
      secure: true,
      auth: { user: this.creds.user, pass: this.creds.password },
      logger: false,
    };

    const rawClient = new ImapFlow(config);
    const client = wrapReadOnly(rawClient);

    const out: RawMail[] = [];
    const cap = opts.maxMessages ?? 200;

    await client.connect();
    try {
      await client.mailboxOpen('INBOX', { readOnly: true });

      const sinceFormatted = formatImapDate(opts.since);
      const searchResult = await client.search({ since: opts.since } as { since: Date });
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];
      // imapflow returns UIDs ascending; cap to most-recent if needed.
      const slice = uids.slice(-cap);

      for (const uid of slice) {
        const msg = await client.fetchOne(
          uid,
          { source: true, envelope: true, internalDate: true },
          { uid: true },
        );
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const fromAddr = parsed.from?.value?.[0]?.address ?? '';
        const fromName = parsed.from?.value?.[0]?.name;
        const toAddr = Array.isArray(parsed.to)
          ? parsed.to[0]?.value?.[0]?.address ?? ''
          : parsed.to?.value?.[0]?.address ?? '';
        const subject = parsed.subject ?? '';
        const body = (parsed.text ?? '').trim();
        const dateRaw = parsed.date ?? msg.internalDate ?? new Date();
        const date = dateRaw instanceof Date ? dateRaw : new Date(dateRaw);
        const reservationMatch = (subject + '\n' + body).match(RESERVATION_RE);

        out.push({
          uid: Number(uid),
          fromAddress: fromAddr,
          fromName: fromName,
          toAddress: toAddr,
          subject,
          body,
          date,
          reservationCode: reservationMatch?.[0],
        });
      }

      // Touch the formatted date string to silence the unused-var checker in case the
      // upstream search() implementation switches to string-form filters.
      void sinceFormatted;
    } finally {
      await client.logout().catch(() => {
        // already disconnected
      });
    }

    return out;
  }
}

function formatImapDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}
