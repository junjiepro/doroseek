// test_utils/mock_kv.ts

// Simple in-memory store to mock Deno.Kv
const memoryStore = new Map<string, any>();

// Counter for list operations if needed for advanced scenarios
let listCallCount = 0;

export const mockKv = {
  atomic: () => {
    // Store operations in a transaction log
    const transactionLog: Array<{
      operation: "set" | "delete" | "check";
      key: Deno.KvKey;
      value?: any;
      versionstamp?: string | null; // For check operation
    }> = [];
    let checksPassed = true;

    const self = {
      check: (...checks: Deno.AtomicCheck[]) => {
        for (const check of checks) {
          const currentEntry = memoryStore.get(JSON.stringify(check.key));
          if (currentEntry?.versionstamp !== check.versionstamp) {
            checksPassed = false;
            break;
          }
        }
        return self;
      },
      mutate: (...mutations: Deno.KvMutation[]) => {
         for (const mutation of mutations) {
            transactionLog.push({
                operation: mutation.type, // 'set' or 'delete'
                key: mutation.key,
                value: (mutation as Deno.KvMutationExt).value, // KvMutationExt for value
            });
         }
         return self;
      },
      set: (key: Deno.KvKey, value: unknown, options?: { expireIn?: number }) => {
        transactionLog.push({ operation: "set", key, value });
        // `options.expireIn` is ignored in this simple mock
        return self;
      },
      delete: (key: Deno.KvKey) => {
        transactionLog.push({ operation: "delete", key });
        return self;
      },
      sum: (key: Deno.KvKey, n: bigint) => {
        const current = (memoryStore.get(JSON.stringify(key)) || {value: new Deno.KvU64(0n)}).value as Deno.KvU64;
        const newValue = new Deno.KvU64(current.value + n);
        transactionLog.push({ operation: "set", key, value: newValue });
        return self;
      },
      min: (key: Deno.KvKey, n: Deno.KvU64) => {
         const current = (memoryStore.get(JSON.stringify(key)) || {value: new Deno.KvU64(n.value)}).value as Deno.KvU64;
         const newValue = new Deno.KvU64(current.value < n.value ? current.value : n.value);
         transactionLog.push({ operation: "set", key, value: newValue });
         return self;
      },
      max: (key: Deno.KvKey, n: Deno.KvU64) => {
         const current = (memoryStore.get(JSON.stringify(key)) || {value: new Deno.KvU64(n.value)}).value as Deno.KvU64;
         const newValue = new Deno.KvU64(current.value > n.value ? current.value : n.value);
         transactionLog.push({ operation: "set", key, value: newValue });
         return self;
      },

      commit: async (): Promise<Deno.KvCommitResult | Deno.KvCommitError> => {
        if (!checksPassed) {
          return { ok: false };
        }
        for (const entry of transactionLog) {
          const keyStr = JSON.stringify(entry.key);
          if (entry.operation === "set") {
            memoryStore.set(keyStr, {
              value: entry.value,
              versionstamp: `v${Date.now()}${Math.random()}`,
            });
          } else if (entry.operation === "delete") {
            memoryStore.delete(keyStr);
          }
        }
        return { ok: true, versionstamp: `commit-v${Date.now()}` };
      },
    };
    return self;
  },
  get: async <T = unknown>(
    key: Deno.KvKey,
    _options?: { consistency?: Deno.KvConsistencyLevel },
  ): Promise<Deno.KvEntryMaybe<T>> => {
    const item = memoryStore.get(JSON.stringify(key));
    if (item === undefined) {
      return { key, value: null, versionstamp: null };
    }
    return { key, value: item.value as T, versionstamp: item.versionstamp };
  },
  getMany: async <T extends unknown[]>(
    keys: Deno.KvKey[],
    _options?: { consistency?: Deno.KvConsistencyLevel },
  ): Promise<Deno.KvEntryMaybe<T[number]>[]> => {
    const results: Deno.KvEntryMaybe<T[number]>[] = [];
    for (const key of keys) {
      const item = memoryStore.get(JSON.stringify(key));
      if (item === undefined) {
        results.push({ key, value: null, versionstamp: null });
      } else {
        results.push({
          key,
          value: item.value as T[number],
          versionstamp: item.versionstamp,
        });
      }
    }
    return results;
  },
  set: async (
    key: Deno.KvKey,
    value: unknown,
    _options?: { expireIn?: number },
  ): Promise<Deno.KvCommitResult> => {
    memoryStore.set(JSON.stringify(key), {
      value,
      versionstamp: `v${Date.now()}${Math.random()}`,
    });
    return { ok: true, versionstamp: `set-v${Date.now()}` };
  },
  delete: async (key: Deno.KvKey): Promise<void> => {
    memoryStore.delete(JSON.stringify(key));
  },
  list: async function* <T = unknown>(
    selector: Deno.KvListSelector,
    _options?: Deno.KvListOptions,
  ): AsyncIterableIterator<Deno.KvEntry<T>> {
    listCallCount++;
    const prefixStr = JSON.stringify((selector as { prefix: Deno.KvKey }).prefix);
    for (const [keyStr, item] of memoryStore.entries()) {
      if (keyStr.startsWith(prefixStr.slice(0, -1))) { // Check if key starts with prefix
        yield {
          key: JSON.parse(keyStr),
          value: item.value as T,
          versionstamp: item.versionstamp,
        };
      }
    }
  },
  enqueue: async (
    value: unknown,
    _options?: { delay?: number; keysIfUndelivered?: Deno.KvKey[] },
  ): Promise<Deno.KvCommitResult> => {
    // Simple mock: immediately "process" or just acknowledge
    console.log("[Mock KV] Enqueued value:", value);
    return { ok: true, versionstamp: `enqueue-v${Date.now()}` };
  },
  listenQueue: async (
    _handler: (value: unknown) => Promise<void> | void,
  ): Promise<void> => {
    // This mock doesn't actively listen or process a queue.
    console.log("[Mock KV] listenQueue called. No active listening in mock.");
    return Promise.resolve();
  },
  close: (): void => {
    // No-op for memory store
    console.log("[Mock KV] close called.");
  },
  // Helper for tests to clear the store
  clear: () => {
    memoryStore.clear();
    listCallCount = 0;
  },
  // Helper to inspect store or call counts
  getStore: () => memoryStore,
  getListCallCount: () => listCallCount,
};

// Example of how to replace the real Deno.openKv in tests:
// import * as mainDb from "./services/database.ts";
// mainDb.db = mockKv as any; // Or more specific mocking if db export is const
// Or: Deno.Kv.prototype.get = mockKv.get; // if you can prototype effectively
// Best: Use dependency injection for db object in your services.
