/** Regression cases for the Slack-doctrine TS port. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNEL_ALERTS,
  CHANNEL_TEAM,
  CONTENT_COOLDOWN_WINDOW_SECONDS,
  contentDedupKey,
  evaluate,
  normalizeForContentHash,
} from './slack-doctrine.js';

// Per-test isolated state dir so cooldown state never leaks across tests.
const tmpDirs: string[] = [];
function freshState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slack-doctrine-spec-'));
  tmpDirs.push(dir);
  return join(dir, 'cooldown.json');
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

// Helper: build a multi-line text with optional ACTION header on line 1.
function makeLongText(n: number, header = ''): string {
  const lines: string[] = header ? [header] : [];
  while (lines.length < n) {
    lines.push(`essay line ${lines.length + 1} — context paragraph filler.`);
  }
  return lines.join('\n');
}

// ─── Golden 1: short top-level #team passes through unchanged ────────

describe('golden case 1 — short message passes through', () => {
  it('returns SENT with original text intact', () => {
    const body =
      '<@U083ZU8PH43> ACTION: approve thing\n' +
      'Context line.\n' +
      'If nothing happens: bad.';
    const d = evaluate({ channel: CHANNEL_TEAM, text: body, stateFile: freshState() });
    expect(d.post).toBe(true);
    if (d.post) {
      expect(d.status).toBe('SENT');
      expect(d.text).toBe(body);
    }
  });
});

// ─── Golden 2: long #team body is delivered unchanged ────────────────

describe('golden case 2 — long ACTION body passes through', () => {
  it('returns SENT with all 12 lines unchanged', () => {
    const header = '<@U083ZU8PH43> ACTION: approve nginx bump 768 -> 8192';
    const body = makeLongText(12, header);
    const d = evaluate({ channel: CHANNEL_TEAM, text: body, stateFile: freshState() });
    expect(d.post).toBe(true);
    if (d.post) {
      expect(d.status).toBe('SENT');
      expect(d.text).toBe(body);
      expect(d.text.split('\n')).toHaveLength(12);
    }
  });
});

// ─── Golden 3: long #team body needs no ACTION header ────────────────

describe('golden case 3 — long body without ACTION header passes through', () => {
  it('does not rewrite or inject content', () => {
    const body = makeLongText(12);
    const d = evaluate({ channel: CHANNEL_TEAM, text: body, stateFile: freshState() });
    expect(d.post).toBe(true);
    if (d.post) {
      expect(d.status).toBe('SENT');
      expect(d.text).toBe(body);
    }
  });
});

// ─── Golden 4: long bodies remain subject to content cooldown ────────

describe('golden case 4 — long duplicate is suppressed', () => {
  it('delivers the first body unchanged and suppresses the duplicate', () => {
    const body = makeLongText(12, '<@U083ZU8PH43> ACTION: weekly incident report');
    const stateFile = freshState();
    const first = evaluate({ channel: CHANNEL_TEAM, text: body, stateFile });
    const duplicate = evaluate({ channel: CHANNEL_TEAM, text: body, stateFile });
    expect(first.post).toBe(true);
    if (first.post) {
      expect(first.status).toBe('SENT');
      expect(first.text).toBe(body);
    }
    expect(duplicate.post).toBe(false);
    if (!duplicate.post) expect(duplicate.status).toBe('SUPPRESSED_CONTENT_DUPLICATE');
  });
});

// ─── Golden 5: #alerts bypasses #team policy checks ───────────────────

describe('golden case 5 — #alerts is not gated', () => {
  it('long bodies pass through unchanged', () => {
    const body = makeLongText(20, 'DONE: massive diagnostic dump');
    const d = evaluate({ channel: CHANNEL_ALERTS, text: body, stateFile: freshState() });
    expect(d.post).toBe(true);
    if (d.post) {
      expect(d.status).toBe('SENT');
      expect(d.text).toBe(body);
    }
  });

  it('repeats are not deduped', () => {
    const state = freshState();
    const body = 'DONE: probe outcome line';
    const a = evaluate({ channel: CHANNEL_ALERTS, text: body, stateFile: state });
    const b = evaluate({ channel: CHANNEL_ALERTS, text: body, stateFile: state });
    expect(a.post && b.post).toBe(true);
    expect(a.status).toBe('SENT');
    expect(b.status).toBe('SENT');
  });
});

// ─── Golden 6: thread replies bypass policy checks ───────────────────

describe('golden case 6 — thread reply bypass', () => {
  it('passes through even when body is long', () => {
    const body = makeLongText(15, '<@U083ZU8PH43> ACTION: details');
    const d = evaluate({
      channel: CHANNEL_TEAM,
      text: body,
      threadTs: '1779700000.123456',
      stateFile: freshState(),
    });
    expect(d.post).toBe(true);
    if (d.post) {
      expect(d.status).toBe('SENT');
      expect(d.text).toBe(body);
    }
  });
});

// ─── Golden 7: identical #team content within 30 min → suppressed ────

describe('golden case 7 — content cooldown fires on duplicate', () => {
  it('returns SUPPRESSED_CONTENT_DUPLICATE on second identical call', () => {
    const state = freshState();
    const text =
      '<@U083ZU8PH43> ACTION: ter info — voucher-INACTIVE spam fix is live.\n' +
      'Same voucher+category now max 1 post per 24u.\n' +
      'If you see dups again: let me know.';
    const first = evaluate({ channel: CHANNEL_TEAM, text, stateFile: state });
    const second = evaluate({ channel: CHANNEL_TEAM, text, stateFile: state });
    expect(first.post).toBe(true);
    expect(second.post).toBe(false);
    if (!second.post) {
      expect(second.status).toBe('SUPPRESSED_CONTENT_DUPLICATE');
      expect(second.reason).toContain('suppressing duplicate');
    }
  });
});

// ─── Golden 8: content cooldown lifts after window expires ───────────

describe('golden case 8 — cooldown lifts after window', () => {
  it('a 1-sec window lets the second call through after a beat', () => {
    const state = freshState();
    let clock = 1_000_000;
    const text = '<@U083ZU8PH43> ACTION: short live test\nline 2\nline 3';
    const first = evaluate({
      channel: CHANNEL_TEAM,
      text,
      stateFile: state,
      contentCooldownSec: 1,
      now: () => clock,
    });
    expect(first.post).toBe(true);
    clock += 2; // 2 seconds later — window expired
    const second = evaluate({
      channel: CHANNEL_TEAM,
      text,
      stateFile: state,
      contentCooldownSec: 1,
      now: () => clock,
    });
    expect(second.post).toBe(true);
    if (second.post) expect(second.status).toBe('SENT');
  });
});

// ─── Golden 9: timestamp/mention/url normalization collides keys ─────

describe('golden case 9 — normalization makes near-duplicates collide', () => {
  it('two posts differing only in timestamps + mentions + URLs hash identically', () => {
    const state = freshState();
    const a =
      '<@U083ZU8PH43> ACTION: investigate cluster X.\n' +
      'Posted at 2026-05-23T14:18:36Z to thread 1779469278.897769.\n' +
      'Details: https://github.com/foo/bar/pull/123';
    const b =
      '<@U0961S209GA> ACTION: investigate cluster X.\n' +
      'Posted at 2026-05-23T14:43:17Z to thread 1779470862.562889.\n' +
      'Details: https://github.com/foo/bar/pull/999';
    const first = evaluate({ channel: CHANNEL_TEAM, text: a, stateFile: state });
    const second = evaluate({ channel: CHANNEL_TEAM, text: b, stateFile: state });
    expect(first.post).toBe(true);
    expect(second.post).toBe(false);
    if (!second.post) expect(second.status).toBe('SUPPRESSED_CONTENT_DUPLICATE');
    // And the dedupKey is what you'd compute from a's content (or b's —
    // they should be equal post-normalization).
    expect(contentDedupKey(CHANNEL_TEAM, a)).toBe(contentDedupKey(CHANNEL_TEAM, b));
  });
});

// ─── Golden 10: distinct ACTIONs are NOT suppressed ──────────────────

describe('golden case 10 — distinct content is not deduped', () => {
  it('two genuinely different ACTION posts both land', () => {
    const state = freshState();
    const a =
      '<@U083ZU8PH43> ACTION: approve nginx bump\nemail blast saturating.\nwithout: dropouts.';
    const b =
      '<@U083ZU8PH43> ACTION: approve Stripe rotation\nlive keys expire tonight.\nwithout: cards fail.';
    const first = evaluate({ channel: CHANNEL_TEAM, text: a, stateFile: state });
    const second = evaluate({ channel: CHANNEL_TEAM, text: b, stateFile: state });
    expect(first.post && second.post).toBe(true);
    expect(first.status).toBe('SENT');
    expect(second.status).toBe('SENT');
    expect((first as Extract<typeof first, { post: true }>).dedupKey).not.toBe(
      (second as Extract<typeof second, { post: true }>).dedupKey,
    );
  });
});

// ─── Bonus: tech-refs footer is blocked from #team ───────────────────

describe('bonus — _Technical refs: footer blocked from #team', () => {
  it('returns BLOCKED_TECH_REFS_IN_TEAM', () => {
    const body =
      '<@U083ZU8PH43> ACTION: real action.\n' +
      'situation.\n' +
      'if nothing.\n' +
      '_Technical refs: repo=foo, pr=#1_';
    const d = evaluate({ channel: CHANNEL_TEAM, text: body, stateFile: freshState() });
    expect(d.post).toBe(false);
    if (!d.post) expect(d.status).toBe('BLOCKED_TECH_REFS_IN_TEAM');
  });

  it('but #alerts allows _Technical refs:_ footer', () => {
    const body =
      'DONE: admin-merge favotrip-monitor#64\n' +
      '_Technical refs: repo=Favosite/favotrip-monitor, pr=#64_';
    const d = evaluate({ channel: CHANNEL_ALERTS, text: body, stateFile: freshState() });
    expect(d.post).toBe(true);
  });
});

// ─── Unit tests on helpers ────────────────────────────────────────────

describe('helpers — normalization', () => {
  it('normalizeForContentHash strips mentions', () => {
    expect(normalizeForContentHash('<@U083ZU8PH43> hello')).toBe('hello');
  });
  it('normalizeForContentHash strips ISO timestamps', () => {
    const a = normalizeForContentHash('post at 2026-05-25T13:41:40Z done');
    const b = normalizeForContentHash('post at 2026-05-22T17:01:18Z done');
    expect(a).toBe(b);
  });
  it('normalizeForContentHash strips slack-ts floats', () => {
    const a = normalizeForContentHash('ref ts=1779469278.897769 done');
    const b = normalizeForContentHash('ref ts=1779470862.562889 done');
    expect(a).toBe(b);
  });
  it('normalizeForContentHash strips URLs', () => {
    const a = normalizeForContentHash('see https://github.com/x/y/pull/123');
    const b = normalizeForContentHash('see https://github.com/x/y/pull/999');
    expect(a).toBe(b);
  });
  it('normalizeForContentHash collapses whitespace and lowercases', () => {
    expect(normalizeForContentHash('Hello    world\n\n\nDone')).toBe('hello world done');
  });
  it('contentDedupKey is channel-scoped', () => {
    const team = contentDedupKey(CHANNEL_TEAM, 'same body');
    const alerts = contentDedupKey(CHANNEL_ALERTS, 'same body');
    expect(team).not.toBe(alerts);
  });
  it('CONTENT_COOLDOWN_WINDOW_SECONDS is 30 min', () => {
    expect(CONTENT_COOLDOWN_WINDOW_SECONDS).toBe(1800);
  });
});
