import { describe, expect, it } from 'vitest';
import { ImapFetchService } from './imap.service.js';

describe('ImapFetchService — single-mailbox lock', () => {
  it('rejects construction with non-klantenservice user', () => {
    expect(
      () =>
        new ImapFetchService({
          host: 'imap.example.com',
          port: 993,
          user: 'someone-else@favotrip.nl',
          password: 'x',
        }),
    ).toThrow(/IMAP user lock violation/);
  });

  it('accepts the canonical klantenservice address', () => {
    expect(
      () =>
        new ImapFetchService({
          host: 'imap.example.com',
          port: 993,
          user: 'klantenservice@favotrip.nl',
          password: 'x',
        }),
    ).not.toThrow();
  });
});
