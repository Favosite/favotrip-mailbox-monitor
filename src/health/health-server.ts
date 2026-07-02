import http from 'node:http';
import type { Server } from 'node:http';
import { LastRunStore } from '../state/last-run.service.js';

/**
 * C13-B11-1 (fix-campagne wave 8): external liveness signal for the
 * mailbox monitor.
 *
 * Root problem: buildDigestMessage([]) intentionally returns "" and the
 * runner suppresses the zero-mail heartbeat by policy (2026-05-23). That
 * is correct product behaviour — but it means "genuinely zero mail" and
 * "IMAP fetch has been silently failing/hanging for hours" are
 * indistinguishable from outside the container: no HTTP port, no Docker
 * HEALTHCHECK, and state.json's lastFetchAt is never exposed externally
 * (see src/state/last-run.service.ts). If the cron loop dies or an IMAP
 * call hangs, the container process itself keeps running (`docker ps`
 * shows healthy) while it silently stops doing anything.
 *
 * Fix: expose a tiny read-only /health endpoint (mirrors the pattern
 * already used in favotrip-monitor's src/healthcheck.ts) that reads
 * state.json's lastFetchAt and reports 200 when the last successful IMAP
 * fetch happened within `staleAfterMs`, 503 otherwise. Wired to a Docker
 * HEALTHCHECK so `docker inspect --format '{{.State.Health.Status}}'`
 * (and any downstream deadman-cron on monitor-ec2-ops, out of scope for
 * this PR) has something real to poll.
 *
 * No new dependency: uses node:http directly, consistent with this
 * repo's minimal-footprint style (no express/fastify anywhere in
 * package.json).
 */
export interface HealthServerOptions {
  port: number;
  stateFilePath: string;
  /** Consider the monitor unhealthy if lastFetchAt is older than this. */
  staleAfterMs: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export function startHealthServer(opts: HealthServerOptions): Server {
  const store = new LastRunStore(opts.stateFilePath);
  const log = opts.log ?? (() => {});

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    store
      .read()
      .then(({ lastFetchAt }) => {
        const ageMs = Date.now() - lastFetchAt.getTime();
        const healthy = ageMs <= opts.staleAfterMs;
        res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: healthy ? 'ok' : 'stale',
            lastFetchAt: lastFetchAt.toISOString(),
            ageMs,
            staleAfterMs: opts.staleAfterMs,
          }),
        );
      })
      .catch((err: Error) => {
        // Can't even read state.json — definitely unhealthy, but don't
        // crash the health server itself over it.
        log('error', 'health.state.read.failed', { err: err.message });
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      });
  });

  server.listen(opts.port, () => {
    log('info', 'health.server.listening', { port: opts.port });
  });

  return server;
}
