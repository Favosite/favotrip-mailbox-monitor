import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConsoleLogPoster,
  DoctrineSlackPoster,
  type SlackPoster,
} from './slack.service.js';
import { CHANNEL_ALERTS, CHANNEL_TEAM } from '../slack-doctrine/slack-doctrine.js';

describe('ConsoleLogPoster', () => {
  it('logs to stdout (dry-run mode)', async () => {
    const poster = new ConsoleLogPoster();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await poster.post('hello world');
    expect(spy).toHaveBeenCalled();
    const arg = String(spy.mock.calls[0][0]);
    expect(arg).toContain('hello world');
    expect(arg).toContain('[slack-dry-run]');
    spy.mockRestore();
  });
});

// ─── DoctrineSlackPoster ───────────────────────────────────────────────

const tmpDirs: string[] = [];
function freshTmp(): { stateFile: string; auditFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'doctrine-slack-spec-'));
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
  shouldThrow = false;
  async post(text: string): Promise<void> {
    if (this.shouldThrow) throw new Error('inner poster down');
    this.posts.push(text);
  }
}

describe('DoctrineSlackPoster — short #team post (pass through)', () => {
  it('forwards short bodies unchanged to inner; no overflow used', async () => {
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
    const body = '<@U083ZU8PH43> ACTION: approve thing\nline 2\nline 3';
    await poster.post(body);
    expect(inner.posts).toEqual([body]);
    expect(overflow.posts).toEqual([]);
  });
});

describe('DoctrineSlackPoster — Gate A (line cap)', () => {
  it('posts 1-liner to #team AND full body to overflow on long #team body', async () => {
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
    const header = '<@U083ZU8PH43> ACTION: investigate cluster';
    const body = [header, 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8'].join('\n');
    await poster.post(body);
    expect(inner.posts).toEqual([header]); // 1-liner only
    expect(overflow.posts).toEqual([body]); // full body
  });

  it('still posts 1-liner if overflow throws (best-effort overflow)', async () => {
    const inner = new RecordingPoster();
    const overflow = new RecordingPoster();
    overflow.shouldThrow = true;
    const { stateFile, auditFile } = freshTmp();
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_TEAM,
      overflowPoster: overflow,
      stateFile,
      auditFile,
    });
    const body = [
      '<@U083ZU8PH43> ACTION: investigate',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
    ].join('\n');
    await poster.post(body);
    expect(inner.posts.length).toBe(1); // 1-liner landed
    // audit captures the overflow failure
    const audit = readFileSync(auditFile, 'utf-8');
    expect(audit).toContain('HARD_CAPPED_OVERFLOW_POST_FAILED');
  });

  it('passes through long body when no overflow poster is configured', async () => {
    const inner = new RecordingPoster();
    const { stateFile, auditFile } = freshTmp();
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_TEAM,
      // no overflowPoster
      stateFile,
      auditFile,
    });
    const header = '<@U083ZU8PH43> ACTION: x';
    const body = [header, 'a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    await poster.post(body);
    // 1-liner is posted to inner even without overflow target
    expect(inner.posts).toEqual([header]);
  });
});

describe('DoctrineSlackPoster — Gate B (content cooldown)', () => {
  it('first post lands; identical 2nd post within window does NOT land', async () => {
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
    const body = '<@U07TM7DKMUF> ACTION: behandel klantmail: partner-issue.';
    await poster.post(body);
    await poster.post(body);
    expect(inner.posts).toEqual([body]); // only first lands
    expect(overflow.posts).toEqual([]); // not capped (≤6 lines)
    // 2nd call wrote audit
    const audit = readFileSync(auditFile, 'utf-8');
    expect(audit).toContain('SUPPRESSED_CONTENT_DUPLICATE');
  });
});

describe('DoctrineSlackPoster — #alerts channel (gates do NOT apply)', () => {
  it('long bodies pass through to inner; no cap, no dedupe', async () => {
    const inner = new RecordingPoster();
    const overflow = new RecordingPoster();
    const { stateFile, auditFile } = freshTmp();
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_ALERTS,
      overflowPoster: overflow,
      stateFile,
      auditFile,
    });
    const body = ['DONE: probe outcome', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    await poster.post(body);
    await poster.post(body);
    expect(inner.posts).toEqual([body, body]); // both land
    expect(overflow.posts).toEqual([]); // no Gate A from #alerts side
  });
});

describe('DoctrineSlackPoster — suppression IS success (no throw)', () => {
  it('on SUPPRESSED, post() returns normally; caller sees success', async () => {
    const inner = new RecordingPoster();
    const { stateFile, auditFile } = freshTmp();
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_TEAM,
      stateFile,
      auditFile,
    });
    const body = 'short ACTION: x\nline 2';
    await poster.post(body);
    // Second post returns without throwing
    await expect(poster.post(body)).resolves.toBeUndefined();
  });

  it('inner throws → DoctrineSlackPoster also throws (caller sees error)', async () => {
    const inner = new RecordingPoster();
    inner.shouldThrow = true;
    const { stateFile, auditFile } = freshTmp();
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_TEAM,
      stateFile,
      auditFile,
    });
    await expect(poster.post('hi')).rejects.toThrow('inner poster down');
  });
});

describe('DoctrineSlackPoster — tech-refs guard', () => {
  it('blocks #team posts containing _Technical refs:_ footer', async () => {
    const inner = new RecordingPoster();
    const { stateFile, auditFile } = freshTmp();
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_TEAM,
      stateFile,
      auditFile,
    });
    await poster.post('ACTION: x\nsituation\n_Technical refs: voucher=A_');
    expect(inner.posts).toEqual([]); // blocked, not posted
    const audit = readFileSync(auditFile, 'utf-8');
    expect(audit).toContain('BLOCKED_TECH_REFS_IN_TEAM');
  });
});

describe('DoctrineSlackPoster — audit JSONL format', () => {
  it('writes one JSON object per suppressed post', async () => {
    const inner = new RecordingPoster();
    const { stateFile, auditFile } = freshTmp();
    const poster = new DoctrineSlackPoster({
      inner,
      channelId: CHANNEL_TEAM,
      stateFile,
      auditFile,
    });
    const body = '<@U07TM7DKMUF> ACTION: behandel partner-issue.';
    await poster.post(body);
    await poster.post(body); // suppressed
    const audit = readFileSync(auditFile, 'utf-8').trim();
    const lines = audit.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1); // only the suppressed call audits
    const row = JSON.parse(lines[0]);
    expect(row.outcome).toBe('SUPPRESSED_CONTENT_DUPLICATE');
    expect(row.channel).toBe(CHANNEL_TEAM);
    expect(row.dedupKey).toBeTruthy();
    expect(row.textPreview).toContain('behandel partner-issue');
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
