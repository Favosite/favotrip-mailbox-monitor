import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueueTaskDispatcher } from './queue-task.service.js';
import type { ProcessedMail } from '../types.js';

const cfg = {
  url: 'https://api.favotrip.nl/monitor/queue-task',
  apiKey: 'test-key',
  timeoutMs: 1000,
};

function makeMail(over: Partial<ProcessedMail> = {}): ProcessedMail {
  return {
    uid: 12345,
    fromHash: 'hash-abc',
    maskedFrom: 'a*** <a***@gmail.com>',
    maskedSubject: 'Vraag over boeking',
    maskedBody: 'masked body',
    manualOnly: false,
    reservationCode: undefined,
    date: new Date('2026-05-19T10:00:00Z'),
    bucket: 'booking_question',
    confidence: 0.85,
    flags: ['repeated_mailer'],
    priority: 'HIGH',
    ...over,
  };
}

describe('QueueTaskDispatcher', () => {
  let log: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    log = vi.fn();
  });

  it('dispatches each HIGH-priority mail and counts queued outcomes', async () => {
    // Each call must return a fresh Response (Response bodies are
    // single-use streams; reusing one across calls makes the 2nd
    // call throw "Body has already been read" and shows up as error).
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            taskId: 'mail-abc-12345',
            queued: true,
            duplicate: false,
            rateLimited: false,
            reason: '',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const d = new QueueTaskDispatcher(cfg, log, fetchMock);

    const result = await d.dispatchHighPriority([
      makeMail({ uid: 1001 }),
      makeMail({ uid: 1002 }),
    ]);

    expect(result).toEqual({
      total: 2,
      attempted: 2,
      queued: 2,
      duplicates: 0,
      rateLimited: 0,
      errors: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('counts duplicate responses separately from queued', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          queued: true,
          duplicate: true,
          rateLimited: false,
          reason: 'duplicate of dispatch_log.id=42',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const d = new QueueTaskDispatcher(cfg, log, fetchMock);

    const result = await d.dispatchHighPriority([makeMail()]);
    expect(result.duplicates).toBe(1);
    expect(result.queued).toBe(0);
  });

  it('counts rateLimited responses separately', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          queued: true,
          duplicate: false,
          rateLimited: true,
          reason: 'rate-limited: source=mail ceiling=3',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const d = new QueueTaskDispatcher(cfg, log, fetchMock);

    const result = await d.dispatchHighPriority([makeMail()]);
    expect(result.rateLimited).toBe(1);
    expect(result.queued).toBe(0);
  });

  it('skips NORMAL-priority mails entirely', async () => {
    const fetchMock = vi.fn();
    const d = new QueueTaskDispatcher(cfg, log, fetchMock);

    const result = await d.dispatchHighPriority([
      makeMail({ priority: 'NORMAL' }),
      makeMail({ priority: 'NORMAL' }),
    ]);

    expect(result.attempted).toBe(0);
    expect(result.queued).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts a 5xx response as error and continues to the next mail', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ queued: true, duplicate: false, rateLimited: false }),
          { status: 200 },
        ),
      );
    const d = new QueueTaskDispatcher(cfg, log, fetchMock);

    const result = await d.dispatchHighPriority([
      makeMail({ uid: 11111 }),
      makeMail({ uid: 22222 }),
    ]);

    expect(result.errors).toBe(1);
    expect(result.queued).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const failedCalls = log.mock.calls.filter(
      (c) => c[1] === 'queue.task.dispatch.failed',
    );
    expect(failedCalls).toHaveLength(1);
  });

  it('strips unsafe characters from uid before building taskId', async () => {
    let capturedBody: { taskId: string; dedupeKey: string } | undefined;
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      const initObj = init as { body: string };
      capturedBody = JSON.parse(initObj.body) as {
        taskId: string;
        dedupeKey: string;
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({ queued: true, duplicate: false, rateLimited: false }),
          { status: 200 },
        ),
      );
    });
    const d = new QueueTaskDispatcher(cfg, log, fetchMock);

    await d.dispatchHighPriority([makeMail({ uid: 987654321 })]);

    expect(capturedBody?.taskId).toBe('mail-987654321');
    expect(capturedBody?.dedupeKey).toBe('mail-987654321');
  });

  it('sends payload + headers per contract', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      capturedInit = init as RequestInit;
      return Promise.resolve(
        new Response(
          JSON.stringify({ queued: true, duplicate: false, rateLimited: false }),
          { status: 200 },
        ),
      );
    });
    const d = new QueueTaskDispatcher(cfg, log, fetchMock);

    await d.dispatchHighPriority([
      makeMail({
        uid: 4242,
        bucket: 'booking_question',
        flags: ['repeated_mailer'],
      }),
    ]);

    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-monitor-api-key']).toBe('test-key');

    const body = JSON.parse(capturedInit?.body as string) as {
      source: string;
      priority: string;
      payload: { bucket: string; flags: string[] };
    };
    expect(body.source).toBe('mail');
    expect(body.priority).toBe('high');
    expect(body.payload.bucket).toBe('booking_question');
    expect(body.payload.flags).toEqual(['repeated_mailer']);
  });

  it('returns empty batch result when input has zero HIGH mails', async () => {
    const fetchMock = vi.fn();
    const d = new QueueTaskDispatcher(cfg, log, fetchMock);
    const result = await d.dispatchHighPriority([]);
    expect(result.attempted).toBe(0);
    expect(result.total).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // No info log when nothing was dispatched (quieter logs)
    expect(log).not.toHaveBeenCalled();
  });
});
