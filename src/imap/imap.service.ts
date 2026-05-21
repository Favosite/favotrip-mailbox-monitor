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
  /** IMAP mailbox to open; default INBOX. Gmail filters skip Inbox so prod uses "[Gmail]/All Mail". */
  mailbox?: string;
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
      logger: { level: "info", info: console.error, debug: () => {}, warn: console.error, error: console.error } as any,
    };

    const rawClient = new ImapFlow(config);
    const client = wrapReadOnly(rawClient);

    const out: RawMail[] = [];
    const cap = opts.maxMessages ?? 200;

    await client.connect();
    try {
      await client.mailboxOpen(opts.mailbox ?? 'INBOX', { readOnly: true });

      const sinceFormatted = formatImapDate(opts.since);
      // 2026-05-21: imapflow's `client.search({ since })` returns
      // SEQUENCE NUMBERS by default. The code below calls
      // `client.fetchOne(id, ..., { uid: true })` treating those ids as
      // UIDs — which silently returns no rows for any mailbox where
      // seqNo != UID (i.e. almost every real mailbox). Discovered while
      // building the Phase-3 keyword classifier dry-run: production
      // `cycle.end processed:0` was caused by this, not by an empty
      // mailbox (33064 mails in [Gmail]/All Mail, 343 since 2026-05-15
      // confirmed via direct IMAP status probe). Fix: pass `{ uid: true
      // }` to search so it returns UIDs that match the subsequent
      // fetchOne UID-mode call.
      const searchResult = await client.search(
        { since: opts.since } as { since: Date },
        { uid: true },
      );
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

        // 2026-05-19: IMAP search({since: Date}) is DATE-ONLY granularity
        // (formats to `19-May-2026` server-side), so it returns every
        // message internalDate >= 00:00 of opts.since's day, not strictly
        // after the datetime. Result: each 5-min cron tick re-fetched all
        // of today's mail and posted the same growing digest to #team —
        // 28 byte-similar copies in 2h observed 2026-05-18 in #alerts.
        // Strict client-side datetime filter to guarantee each mail is
        // posted in exactly one digest. The boundary uses `<=` so a mail
        // dated exactly at the previous cycle's lastFetchAt is excluded
        // (it was already processed in that cycle).
        if (date <= opts.since) continue;

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
