import { promises as fs } from 'node:fs';
import path from 'node:path';

interface LastRunFile {
  lastFetchAt: string;
  lastZeroPostAt?: string;
}

export class LastRunStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<{ lastFetchAt: Date; lastZeroPostAt?: Date }> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as LastRunFile;
      return {
        lastFetchAt: new Date(parsed.lastFetchAt),
        lastZeroPostAt: parsed.lastZeroPostAt ? new Date(parsed.lastZeroPostAt) : undefined,
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // First run: default lookback 5 minutes
        return { lastFetchAt: new Date(Date.now() - 5 * 60 * 1000) };
      }
      throw err;
    }
  }

  async write(state: { lastFetchAt: Date; lastZeroPostAt?: Date }): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const file: LastRunFile = {
      lastFetchAt: state.lastFetchAt.toISOString(),
      lastZeroPostAt: state.lastZeroPostAt?.toISOString(),
    };
    await fs.writeFile(this.filePath, JSON.stringify(file, null, 2), 'utf8');
  }
}
