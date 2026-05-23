import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * OwnerPostCooldownStore
 *
 * Per-owner timestamp store for top-level #team mailbox-action posts.
 * Used to enforce a "max 1 post per owner per N minutes" rule unless
 * a P0/P1 keyword hit is present in the batch (then the cooldown is
 * bypassed because customer impact is urgent enough to override the
 * dedup).
 *
 * Dennis 2026-05-23 third iteration: multiple manual-only mails
 * within an hour were producing two separate #team ACTION posts
 * (20:30 + 21:15 today). The cooldown bundles them into the first
 * post for the cycle; the rest is captured by the suppressed-counts
 * state for the 09:00 rollup.
 *
 * File format (forward-compatible for multiple owners):
 *   {
 *     "U07TM7DKMUF": "2026-05-23T20:30:00.000Z",
 *     "U083ZU8PH43": "..."     // future
 *   }
 *
 * The store auto-creates the directory on write. Missing file is
 * treated as empty state (no prior posts known).
 */
export class OwnerPostCooldownStore {
  private cache: Record<string, string> | null = null;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, string>;
      this.cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.cache = {};
        return;
      }
      throw err;
    }
  }

  async save(): Promise<void> {
    if (!this.cache) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  /**
   * Mark that ownerUid received a top-level #team post at `at`.
   * Caller is responsible for invoking save() to persist.
   */
  markPosted(ownerUid: string, at: Date): void {
    if (!this.cache) this.cache = {};
    this.cache[ownerUid] = at.toISOString();
  }

  /**
   * Last-post timestamp for ownerUid, or undefined when never posted
   * (or file was empty / didn't exist).
   */
  lastPostAt(ownerUid: string): Date | undefined {
    if (!this.cache) return undefined;
    const iso = this.cache[ownerUid];
    return iso ? new Date(iso) : undefined;
  }

  /**
   * True iff the last post for ownerUid was within `cooldownMinutes`
   * of `now`. False when the owner has no last-post timestamp.
   */
  inCooldown(ownerUid: string, now: Date, cooldownMinutes: number): boolean {
    const last = this.lastPostAt(ownerUid);
    if (!last) return false;
    const diffMs = now.getTime() - last.getTime();
    return diffMs < cooldownMinutes * 60_000;
  }
}
