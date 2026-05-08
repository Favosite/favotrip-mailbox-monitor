import { describe, expect, it, vi } from 'vitest';
import { ReadOnlyImapViolation, wrapReadOnly } from './readonly-guard.js';

describe('readonly-guard', () => {
  it('throws on messageMove', () => {
    const stub = { messageMove: vi.fn() };
    const guarded = wrapReadOnly(stub);
    expect(() => (guarded as { messageMove: () => void }).messageMove()).toThrow(
      ReadOnlyImapViolation,
    );
    expect(stub.messageMove).not.toHaveBeenCalled();
  });

  it('throws on messageDelete', () => {
    const stub = { messageDelete: vi.fn() };
    const guarded = wrapReadOnly(stub) as { messageDelete: () => void };
    expect(() => guarded.messageDelete()).toThrow(ReadOnlyImapViolation);
  });

  it('throws on messageFlagsAdd', () => {
    const stub = { messageFlagsAdd: vi.fn() };
    const guarded = wrapReadOnly(stub) as { messageFlagsAdd: () => void };
    expect(() => guarded.messageFlagsAdd()).toThrow(ReadOnlyImapViolation);
  });

  it('throws on messageFlagsSet', () => {
    const stub = { messageFlagsSet: vi.fn() };
    const guarded = wrapReadOnly(stub) as { messageFlagsSet: () => void };
    expect(() => guarded.messageFlagsSet()).toThrow(ReadOnlyImapViolation);
  });

  it('throws on messageAppend / append', () => {
    const stub = { append: vi.fn(), messageAppend: vi.fn() };
    const guarded = wrapReadOnly(stub) as { append: () => void; messageAppend: () => void };
    expect(() => guarded.append()).toThrow(ReadOnlyImapViolation);
    expect(() => guarded.messageAppend()).toThrow(ReadOnlyImapViolation);
  });

  it('throws on mailboxDelete + mailboxRename', () => {
    const stub = { mailboxDelete: vi.fn(), mailboxRename: vi.fn() };
    const guarded = wrapReadOnly(stub) as { mailboxDelete: () => void; mailboxRename: () => void };
    expect(() => guarded.mailboxDelete()).toThrow(ReadOnlyImapViolation);
    expect(() => guarded.mailboxRename()).toThrow(ReadOnlyImapViolation);
  });

  it('blocks property-set entirely', () => {
    const stub: Record<string, unknown> = { foo: 1 };
    const guarded = wrapReadOnly(stub) as Record<string, unknown>;
    expect(() => {
      guarded.foo = 99;
    }).toThrow(ReadOnlyImapViolation);
  });

  it('forwards safe methods (fetch, search, mailboxOpen)', async () => {
    const stub = {
      fetch: vi.fn().mockResolvedValue('ok'),
      search: vi.fn().mockResolvedValue([1, 2]),
      mailboxOpen: vi.fn().mockResolvedValue(undefined),
    };
    const guarded = wrapReadOnly(stub) as typeof stub;
    await expect(guarded.fetch()).resolves.toBe('ok');
    await expect(guarded.search()).resolves.toEqual([1, 2]);
    await expect(guarded.mailboxOpen()).resolves.toBeUndefined();
    expect(stub.fetch).toHaveBeenCalled();
    expect(stub.search).toHaveBeenCalled();
    expect(stub.mailboxOpen).toHaveBeenCalled();
  });

  it('error message names the offending method', () => {
    const stub = { messageMove: vi.fn() };
    const guarded = wrapReadOnly(stub) as { messageMove: () => void };
    try {
      guarded.messageMove();
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('messageMove');
      expect((e as Error).message).toContain('forbidden');
    }
  });
});
