# favotrip-mailbox-monitor

Read-only IMAP → classify → PII-mask → Slack digest. **Observe only — never replies, never moves money, never modifies bookings.**

## What it does

Every 5 minutes, the worker:

1. Fetches new mail from `klantenservice@favotrip.nl` via IMAP (read-only, single-mailbox lock).
2. Parses each message (MIME → text + headers).
3. Runs PII-mask: IBAN / card / medical content → marked `manual-only` and body redacted; names / emails / phones masked in-place.
4. Classifies into one of 6 buckets (`booking_question`, `cancellation_request`, `refund_request`, `partner_issue`, `general_info`, `spam_out_of_scope`) plus `needs_human_review`.
5. Detects manipulation flags: sob-story money demands, legal threats, chargeback mentions, repeated mailers (>=3 in 7 days, hash-only persistence).
6. Posts a privacy-masked digest to Slack `#team`.

If 0 mails arrived: posts `0 mails` heartbeat at most once per hour, otherwise stays silent.

## Hard guardrails

- IMAP read-only Proxy-wrapper rejects `messageMove` / `messageDelete` / `messageFlagsAdd` / `messageFlagsSet` / `messageAppend` / `mailboxCreate` / `mailboxRename` / `mailboxDelete` / `append` / `expunge`.
- Single-mailbox lock: `IMAP_USERNAME` env-var must equal `klantenservice@favotrip.nl`. Anything else fails Zod validation at startup.
- No outbound mail: no `nodemailer`, no `@aws-sdk/client-ses`, no SMTP client. CI grep enforces this.
- IMAP credentials read from AWS Secrets Manager at runtime. Never logged. Not in `.env`.
- PII-mask is unit-tested with green coverage gate (≥70%). The mask runs **before** any Slack post.
- Repeated-mailer store persists only `sha256(salt:address)` hashes — never the raw address.

## Local dev

```bash
npm install
npm run typecheck
npm test
npm run demo:synthetic   # runs synthetic fixtures through the full pipeline, prints digest
```

## Coverage

```bash
npm run test:cov
```

Thresholds: 70% across lines / functions / branches / statements.

## Deploy

Currently the synthetic-fixture pipeline runs end-to-end. **The system is not yet wired to live IMAP** — that step requires explicit Jeanne sign-off plus AWS Secrets Manager provisioning. See the PR body for go-live steps.

## Disable

To stop the monitor cleanly:

```bash
docker stop favotrip-mailbox-monitor
```

Removing the container does not affect the live mailbox in any way — the worker only reads.
