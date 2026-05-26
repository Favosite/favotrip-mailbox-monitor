/**
 * Cross-layer regression for the 2026-05-25 observed #team noise class.
 *
 * Composes `buildDigestMessage()` (digest text builder) with
 * `DoctrineSlackPoster` (Gate A + Gate B). Asserts:
 *   1. A realistic partner-issue digest, posted twice within 30 min,
 *      collapses to a single landed post (Gate B).
 *   2. A hypothetical 12-line ACTION digest body lands as a 1-liner
 *      in #team plus the full body in #alerts (Gate A).
 *   3. The 2026-05-25 burst pattern (4 identical posts within 30 min
 *      + 1 fresh post 24h later) collapses to ≤2 landed posts.
 *
 * Why this file is named with the date: this is the canonical fixture
 * documenting the noise the doctrine PR is intended to stop. If a
 * future regression re-introduces the noise class, this file fails
 * with a name that immediately points an operator at the right thread
 * + the Slack-history exhibits.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDigestMessage } from '../../src/digest/digest.service.js';
import {
  DoctrineSlackPoster,
  type SlackPoster,
} from '../../src/digest/slack.service.js';
import { CHANNEL_TEAM } from '../../src/slack-doctrine/slack-doctrine.js';
import type { ProcessedMail } from '../../src/types.js';

// ─── shared fixtures ───────────────────────────────────────────────────

const tmpDirs: string[] = [];
function freshTmp(): { stateFile: string; auditFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mbox-noise-spec-'));
  tmpDirs.push(dir);
  return {
    stateFile: join(dir, 'cooldown.json'),
    auditFile: join(dir, 'suppressed.jsonl'),
  };
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

class RecordingPoster implements SlackPoster {
  posts: string[] = [];
  async post(text: string): Promise<void> {
    this.posts.push(text);
  }
}

/** Construct a minimum ProcessedMail with a partner-issue bucket so
 *  buildDigestMessage will treat it as interrupt-worthy. */
function partnerIssueMail(seedIdx: number): ProcessedMail {
  return {
    id: `mail-${seedIdx}`,
    fromHash: `hash-${seedIdx}`,
    receivedAt: new Date(),
    subjectMasked: 'partner issue',
    bodyMasked: 'partner needs attention',
    bucket: 'partner_issue',
    bucketScores: { partner_issue: 5 },
    priority: 'NORMAL',
    manualOnly: false,
    keywordHit: undefined,
    flags: [],
    repeatedMailer: false,
  };
}

// ─── (1) digest regression — 2 identical posts in 30 min ───────────────

describe('mailbox noise regression — 2 identical partner-issue posts within 30 min', () => {
  it('builds the same digest twice; 2nd post is suppressed by Gate B', async () => {
    const mails = [partnerIssueMail(1), partnerIssueMail(2)];
    const text = buildDigestMessage(mails);
    // sanity: digest text is a single ACTION line for partner-issue
    expect(text).toMatch(/^<@U[A-Z0-9]+> ACTION: behandel/);
    expect(text).toContain('partner-issue');

    const inner = new RecordingPoster();
    const overflow = new RecordingPoster();
    const { stateFile, auditFile } = freshTmp();
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_TEAM,
      overflowPoster: overflow,
      stateFile,
      auditFile,
    });

    await poster.post(text);
    await poster.post(text); // identical content within seconds
    expect(inner.posts.length).toBe(1); // only first landed
    expect(overflow.posts.length).toBe(0); // <=6 lines → no Gate A

    const audit = readFileSync(auditFile, 'utf-8');
    expect(audit).toContain('SUPPRESSED_CONTENT_DUPLICATE');
  });
});

// ─── (2) digest regression — 12-line ACTION digest is capped + routed ──

describe('mailbox noise regression — 12-line ACTION digest body is capped to 1-liner', () => {
  it('Gate A routes the 1-line ACTION header to #team + full body to overflow', async () => {
    // Hypothetical: a future regression makes buildDigestMessage emit a
    // multi-paragraph essay. The doctrine catches it before it lands in
    // #team, even if the digest builder itself regresses.
    const header = '<@U0961S209GA> ACTION: behandel 4 urgente klantmails: partner-issue, refund, annulering, +1 meer.';
    const longBody = [
      header,
      '',
      '*Impact:*',
      '4 customers are waiting on partner-issue triage.',
      '',
      '*Cause:*',
      'Mailbox bucket-distribution skewed toward partner_issue today.',
      '',
      '*What to do:*',
      'Open klantenservice@favotrip.nl and process by oldest-first.',
      '',
      '*Owner:* Jeanne / klantenservice',
    ].join('\n');
    expect(longBody.split('\n').length).toBeGreaterThan(6); // sanity

    const inner = new RecordingPoster();
    const overflow = new RecordingPoster();
    const { stateFile, auditFile } = freshTmp();
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_TEAM,
      overflowPoster: overflow,
      stateFile,
      auditFile,
    });

    await poster.post(longBody);
    // #team gets the 1-liner ACTION header verbatim (Gate A extraction)
    expect(inner.posts).toEqual([header]);
    // #alerts gets the full body (Gate A overflow)
    expect(overflow.posts).toEqual([longBody]);
  });
});

// ─── (3) the 2026-05-25 burst pattern — ≤2 posts land in 48h ──────────

describe('mailbox noise regression — observed 2026-05-25 burst pattern', () => {
  it('4 identical posts within 30 min + 1 fresh 24h later → ≤2 posts land', async () => {
    // Slack history showed 4× near-identical "behandel … partner-issue"
    // posts in a tight window, then another posted hours later. The
    // doctrine should collapse the burst (Gate B 30-min window) and
    // pass the 24h-later fresh post (window expired).
    const inner = new RecordingPoster();
    const overflow = new RecordingPoster();
    const { stateFile, auditFile } = freshTmp();
    let nowSec = 1_700_000_000;
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_TEAM,
      overflowPoster: overflow,
      stateFile,
      auditFile,
      now: () => nowSec,
    });

    const text =
      '<@U0961S209GA> ACTION: behandel urgente klantmail: partner-issue.';

    // Burst: 4 identical posts at t = 0, 7, 14, 21 min (all within 30 min)
    for (let i = 0; i < 4; i++) {
      await poster.post(text);
      nowSec += 7 * 60;
    }
    // Now advance 24h past the burst start
    nowSec = 1_700_000_000 + 24 * 3600;
    // 1 fresh post (cooldown has expired)
    await poster.post(text);

    // Doctrine should yield: 1 from the burst + 1 fresh = 2 ≤ 2 ✓
    expect(inner.posts.length).toBeLessThanOrEqual(2);
    expect(inner.posts.length).toBeGreaterThanOrEqual(1); // at least one landed
  });

  it('6 identical partner-issue posts inside one 30-min window collapse to exactly 1', async () => {
    // Worst-case burst (e.g. cron mis-firing every 5 min on same mailbox state):
    // 6 identical posts within 25 min. Doctrine catches all 5 follow-ups.
    const inner = new RecordingPoster();
    const { stateFile, auditFile } = freshTmp();
    let nowSec = 1_700_000_000;
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_TEAM,
      stateFile,
      auditFile,
      now: () => nowSec,
    });

    const text =
      '<@U0961S209GA> ACTION: behandel urgente klantmail: partner-issue.';
    for (let i = 0; i < 6; i++) {
      await poster.post(text);
      nowSec += 5 * 60;
    }
    expect(inner.posts.length).toBe(1);
  });
});
