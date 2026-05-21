/**
 * Phase-3 keyword-classifier DRY-RUN (Dennis 2026-05-21).
 *
 * Reads mails from --since (default 2026-05-15) via the existing
 * read-only IMAP path (same creds, same readonly-guard, same Zod-locked
 * username). Runs each parsed mail through the keyword classifier ONLY.
 * No Slack post, no dedupe-state write, no DB touch, no IMAP write.
 *
 * Output: per-mail summary line then an aggregate footer.
 *
 * Usage (on prod-EC2 inside the container or via tsx locally with
 * matching env):
 *   docker exec -e DRY_RUN=true favotrip-mailbox-monitor \
 *     node /app/dist/scripts/replay-keyword-dryrun.js --since 2026-05-15
 *
 * Or locally:
 *   npx tsx scripts/replay-keyword-dryrun.ts --since 2026-05-15
 *
 * PII safety: every printed line uses the SAME masking pipeline as
 * production (maskFromHeader, maskSubject, maskBody) — never the raw
 * email or full name.
 */
import { loadConfig } from '../src/config.js';
import {
  AwsSecretsClient,
  EnvSecretsClient,
  type SecretsClient,
} from '../src/secrets/secrets.service.js';
import { ImapFetchService } from '../src/imap/imap.service.js';
import { classifyKeywords } from '../src/classifier/keyword-monitor.service.js';
import {
  maskBody,
  maskFromHeader,
  maskSubject,
} from '../src/pii-mask/pii-mask.service.js';

function parseArgs(argv: string[]): { since: Date; max: number } {
  let since: Date | undefined;
  let max = 5000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') {
      since = new Date(argv[++i] ?? '');
    } else if (a === '--max') {
      max = Number(argv[++i] ?? max);
    }
  }
  if (!since || Number.isNaN(since.getTime())) {
    since = new Date('2026-05-15T00:00:00Z');
  }
  return { since, max };
}

function trim(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function main(): Promise<void> {
  const { since, max } = parseArgs(process.argv.slice(2));
  // Allow DRY_RUN=true; the loaded config tolerates missing keyword vars.
  const cfg = loadConfig();

  const secrets: SecretsClient = process.env.DEV_IMAP_HOST
    ? new EnvSecretsClient()
    : new AwsSecretsClient(cfg.AWS_REGION);

  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: 'dryrun.start',
      since: since.toISOString(),
      max,
      mailbox: cfg.IMAP_MAILBOX,
    }),
  );

  const creds = await secrets.getImapCredentials(cfg.IMAP_SECRET_ID);
  const fetcher = new ImapFetchService(creds);
  const raw = await fetcher.fetchSince({
    since,
    maxMessages: max,
    mailbox: cfg.IMAP_MAILBOX,
  });

  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: 'dryrun.fetched',
      count: raw.length,
    }),
  );

  let p0 = 0;
  let p1 = 0;
  let noHit = 0;

  // Header line for the summary stream (stdout)
  console.log(
    [
      'ts',
      'from-masked',
      'subject-trim',
      'severity',
      'keywords-hit',
    ].join(' | '),
  );
  console.log('-'.repeat(120));

  for (const m of raw) {
    const hit = classifyKeywords({ subject: m.subject, body: m.body });
    if (hit?.severity === 'P0') p0++;
    else if (hit?.severity === 'P1') p1++;
    else noHit++;

    // Mask everything before logging — same pipeline as prod.
    const maskedFrom = maskFromHeader(
      m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
    );
    const maskedSubj = maskSubject(m.subject ?? '');
    const ts = m.date.toISOString().replace('T', ' ').slice(0, 16);
    const severity = hit ? hit.severity : '-';
    const keywords = hit ? JSON.stringify(hit.keywords) : '';

    console.log(
      [
        ts,
        trim(maskedFrom, 40),
        trim(maskedSubj, 60),
        severity,
        keywords,
      ].join(' | '),
    );
  }

  console.log('-'.repeat(120));
  console.log(
    JSON.stringify(
      {
        total: raw.length,
        P0: p0,
        P1: p1,
        no_hit: noHit,
        since: since.toISOString(),
      },
      null,
      2,
    ),
  );

  // Extra safety: explicitly do NOT write anything.
  // No dedupe-state, no last-run state, no Slack post.
}

main().catch((err: Error) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'dryrun.failed',
      err: err.message,
    }),
  );
  process.exit(1);
});
