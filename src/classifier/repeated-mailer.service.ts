import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface SenderRecord {
  hash: string;
  timestamps: string[];
}

interface Store {
  records: SenderRecord[];
}

export interface RepeatedMailerConfig {
  filePath: string;
  salt: string;
  thresholdCount: number;
  windowDays: number;
}

export class RepeatedMailerStore {
  private store: Store = { records: [] };
  private loaded = false;

  constructor(private readonly cfg: RepeatedMailerConfig) {}

  static hashAddress(address: string, salt: string): string {
    return createHash('sha256').update(salt + ':' + address.toLowerCase().trim()).digest('hex');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.cfg.filePath, 'utf8');
      this.store = JSON.parse(raw) as Store;
      if (!this.store.records) this.store.records = [];
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.store = { records: [] };
      } else {
        throw err;
      }
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    if (!this.loaded) return;
    await fs.mkdir(path.dirname(this.cfg.filePath), { recursive: true });
    await fs.writeFile(this.cfg.filePath, JSON.stringify(this.store, null, 2), 'utf8');
  }

  /**
   * Record a sighting for the given address (hashed-only). Returns whether the sender is now considered "repeated"
   * (>= thresholdCount sightings within windowDays).
   */
  observe(address: string, at: Date = new Date()): { hash: string; isRepeated: boolean; count: number } {
    const hash = RepeatedMailerStore.hashAddress(address, this.cfg.salt);
    const cutoff = new Date(at.getTime() - this.cfg.windowDays * 24 * 60 * 60 * 1000);

    let record = this.store.records.find((r) => r.hash === hash);
    if (!record) {
      record = { hash, timestamps: [] };
      this.store.records.push(record);
    }

    record.timestamps = record.timestamps.filter((t) => new Date(t) >= cutoff);
    record.timestamps.push(at.toISOString());

    return { hash, isRepeated: record.timestamps.length >= this.cfg.thresholdCount, count: record.timestamps.length };
  }

  /** Drop records that have no sightings in the window — keeps the store from growing unboundedly. */
  prune(now: Date = new Date()): void {
    const cutoff = new Date(now.getTime() - this.cfg.windowDays * 24 * 60 * 60 * 1000);
    this.store.records = this.store.records
      .map((r) => ({
        hash: r.hash,
        timestamps: r.timestamps.filter((t) => new Date(t) >= cutoff),
      }))
      .filter((r) => r.timestamps.length > 0);
  }
}
