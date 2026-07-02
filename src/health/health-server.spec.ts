import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { Server } from 'node:http';
import { LastRunStore } from '../state/last-run.service.js';
import { startHealthServer } from './health-server.js';

function get(port: number, urlPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      })
      .on('error', reject);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no port')));
      }
    });
  });
}

describe('health-server (C13-B11-1)', () => {
  let dir: string;
  let stateFilePath: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-srv-'));
    stateFilePath = path.join(dir, 'state.json');
    port = await freePort();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns 200 ok when lastFetchAt is recent', async () => {
    const store = new LastRunStore(stateFilePath);
    await store.write({ lastFetchAt: new Date() });

    server = startHealthServer({ port, stateFilePath, staleAfterMs: 10 * 60_000 });

    const res = await get(port, '/health');
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('ok');
  });

  it('returns 503 stale when lastFetchAt is older than staleAfterMs -- reproduces the silent-hang gap C13-B11-1 closes', async () => {
    const store = new LastRunStore(stateFilePath);
    const oldFetch = new Date(Date.now() - 60 * 60_000); // 1h ago
    await store.write({ lastFetchAt: oldFetch });

    server = startHealthServer({ port, stateFilePath, staleAfterMs: 10 * 60_000 }); // 10 min threshold

    const res = await get(port, '/health');
    expect(res.status).toBe(503);
    expect((res.body as { status: string }).status).toBe('stale');
  });

  it('returns 503 when state.json does not exist yet (fresh container, not yet run) -- LastRunStore default lookback (5 min) is inside the default 10-min threshold, so this only reproduces past that window', async () => {
    server = startHealthServer({ port, stateFilePath, staleAfterMs: 1 }); // 1ms: force staleness even for the 5-min default lookback

    const res = await get(port, '/health');
    expect(res.status).toBe(503);
  });

  it('returns 404 for any other path', async () => {
    const store = new LastRunStore(stateFilePath);
    await store.write({ lastFetchAt: new Date() });
    server = startHealthServer({ port, stateFilePath, staleAfterMs: 10 * 60_000 });

    const res = await get(port, '/other');
    expect(res.status).toBe(404);
  });
});
