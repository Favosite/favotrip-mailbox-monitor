/**
 * 10 golden-case tests for the Slack-doctrine TS port. The cases mirror
 * server-claude-worker `scripts/monitors/tests/test_slack_post.py` so a
 * future cross-impl parity test can assert both implementations agree
 * byte-for-byte on these inputs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNEL_ALERTS,
  CHANNEL_TEAM,
  CONTENT_COOLDOWN_WINDOW_SECONDS,
  MAX_TEAM_LINES,
  contentDedupKey,
  evaluate,
  extractActionSummary,
  lineCount,
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

// ─── Golden 1: ≤6-line top-level #team passes through unchanged ──────

describe('golden case 1 — below cap passes through', () => {
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
      expect(d.full_detail_routed_to_channel).toBeUndefined();
    }
  });
});

// ─── Golden 2: >6-line #team with ACTION header keeps line 1 verbatim ─

describe('golden case 2 — line cap with ACTION header', () => {
  it('returns HARD_CAPPED with first line preserved + overflow routed to #alerts', () => {
    const header = '<@U083ZU8PH43> ACTION: approve nginx bump 768 -> 8192';
    const body = makeLongText(MAX_TEAM_LINES + 4, header);
    const d = evaluate({ channel: CHANNEL_TEAM, text: body, stateFile: freshState() });
    expect(d.post).toBe(true);
    if (d.post) {
      expect(d.status).toBe('HARD_CAPPED_TO_ACTION_SUMMARY');
      expect(d.text).toBe(header);
      expect(d.full_detail_routed_to_channel).toBe(CHANNEL_ALERTS);
      expect(d.full_detail_text).toBe(body);
      expect(d.text).not.toContain('essay line');
    }
  });
});

// ─── Golden 3: >6-line #team WITHOUT ACTION header → generic pointer ─

describe('golden case 3 — line cap without ACTION header', () => {
  it('returns generic pointer (no auto @-mention)', () => {
    const body = makeLongText(MAX_TEAM_LINES + 2);
    const d = evaluate({ channel: CHANNEL_TEAM, text: body, stateFile: freshState() });
    expect(d.post).toBe(true);
    if (d.post) {
      expect(d.status).toBe('HARD_CAPPED_TO_ACTION_SUMMARY');
      expect(d.text.toLowerCase()).toContain('see #alerts');
      expect(d.text).not.toContain('<@U'); // no auto-generated @-mention
    }
  });
});

// ─── Golden 4: policyApprovedLongForm bypasses the cap ─────────────────

describe('golden case 4 — policyApprovedLongForm escape valve', () => {
  it('returns SENT with the long body intact', () => {
    const body = makeLongText(
      MAX_TEAM_LINES + 8,
      '<@U083ZU8PH43> ACTION: weekly incident report',
    );
    const d = evaluate({
      channel: CHANNEL_TEAM,
      text: body,
      stateFile: freshState(),
      policyApprovedLongForm: true,
    });
    expect(d.post).toBe(true);
    if (d.post) {
      expect(d.status).toBe('SENT');
      expect(d.text).toBe(body);
      expect(d.full_detail_routed_to_channel).toBeUndefined();
    }
  });
});

// ─── Golden 5: #alerts never gets capped (technical channel) ─────────

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

// ─── Golden 6: thread replies bypass both gates ──────────────────────

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

describe('helpers — normalization + summary extraction', () => {
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
  it('extractActionSummary preserves ACTION-header line verbatim', () => {
    const line = '<@U083ZU8PH43> ACTION: do thing';
    const body = `${line}\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8`;
    expect(extractActionSummary(body, MAX_TEAM_LINES)).toBe(line);
  });
  it('extractActionSummary generates pointer when no ACTION header', () => {
    const body = makeLongText(MAX_TEAM_LINES + 3);
    const summary = extractActionSummary(body, MAX_TEAM_LINES);
    expect(summary.toLowerCase()).toContain('see #alerts');
    expect(summary).not.toContain('<@U');
  });
  it('lineCount handles empty + single-line + multi-line', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('hello')).toBe(1);
    expect(lineCount('a\nb\nc')).toBe(3);
  });
  it('CONTENT_COOLDOWN_WINDOW_SECONDS is 30 min', () => {
    expect(CONTENT_COOLDOWN_WINDOW_SECONDS).toBe(1800);
  });
  it('MAX_TEAM_LINES is 6', () => {
    expect(MAX_TEAM_LINES).toBe(6);
  });
});
