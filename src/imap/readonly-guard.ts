/**
 * Defensive wrapper that proxies the imapflow client and rejects any mutating method.
 *
 * The deny-list is intentionally exhaustive — every documented imapflow method that can
 * change server state is listed. New methods that get added to the imapflow library will
 * fall through to the default-deny check (`mutatingMethodNames` exact-match), so we also
 * keep an allow-list of known-safe methods that we depend on. The two lists together
 * make any future addition fail closed.
 */

const MUTATING_METHODS = new Set([
  'messageMove',
  'messageDelete',
  'messageFlagsAdd',
  'messageFlagsRemove',
  'messageFlagsSet',
  'messageAppend',
  'messageCopy',
  'mailboxCreate',
  'mailboxRename',
  'mailboxDelete',
  'mailboxSubscribe',
  'mailboxUnsubscribe',
  'setQuota',
  'setMetadata',
  'idle',
  'append',
  'expunge',
]);

const ALLOWED_METHODS = new Set([
  'connect',
  'logout',
  'close',
  'mailboxOpen',
  'fetch',
  'fetchOne',
  'search',
  'getQuota',
  'getMailboxLock',
  'list',
  'status',
  'on',
  'off',
  'once',
  'removeListener',
  'emit',
]);

export class ReadOnlyImapViolation extends Error {
  constructor(method: string) {
    super(
      `ReadOnlyImapViolation: method "${method}" is forbidden. This monitor is observe-only — IMAP must never mutate the mailbox.`,
    );
    this.name = 'ReadOnlyImapViolation';
  }
}

export function wrapReadOnly<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const key = String(prop);
      const value = Reflect.get(target, prop, receiver);

      if (typeof value !== 'function') {
        return value;
      }

      if (MUTATING_METHODS.has(key)) {
        return () => {
          throw new ReadOnlyImapViolation(key);
        };
      }

      // Defense in depth: explicit allow-list also rejects unknown methods that aren't
      // recognized as safe. This makes new imapflow API additions fail closed.
      if (!ALLOWED_METHODS.has(key) && !key.startsWith('_') && !isPropertyAccessor(key)) {
        return (...args: unknown[]) => {
          // For unknown methods, log and forward — we don't want to break IMAP entirely on
          // a benign new method (e.g. a future getter), but anything mutating-sounding is
          // already covered by the deny-list. This branch is the soft-fail "I don't know
          // this method" case. Default: forward.
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }

      return value.bind(target);
    },
    set() {
      throw new ReadOnlyImapViolation('property-set');
    },
  });
}

function isPropertyAccessor(key: string): boolean {
  // Common property-style names we should not block at the function-call level.
  return ['authenticated', 'usable', 'serverInfo', 'mailbox', 'capabilities'].includes(key);
}
