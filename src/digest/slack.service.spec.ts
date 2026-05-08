import { describe, expect, it, vi } from 'vitest';
import { ConsoleLogPoster } from './slack.service.js';

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
