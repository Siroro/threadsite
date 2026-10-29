interface QueueState {
  tail: Promise<unknown>;
  waiters: Array<{ release(): void }>;
}

/** Per-thread ordering, including recovery from a queue holder that never settles. */
export class ThreadQueue {
  private readonly states = new Map<string, QueueState>();

  enqueue<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    let state = this.states.get(threadId);
    if (!state) {
      state = { tail: Promise.resolve(), waiters: [] };
      this.states.set(threadId, state);
    }
    const previous = state.tail;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const gate = { release };
    state.waiters.push(gate);
    const next = (async () => {
      await Promise.race([previous.catch(() => undefined), released]);
      const index = state.waiters.indexOf(gate);
      if (index >= 0) state.waiters.splice(index, 1);
      return work();
    })();
    const tracked = next.finally(() => {
      if (this.states.get(threadId) === state && state.tail === tracked) this.states.delete(threadId);
    });
    // Ordering must not create a second, unhandled rejection on work failure.
    tracked.catch(() => undefined);
    state.tail = tracked;
    return next;
  }

  /** Release only the first waiter; later work remains ordered behind it. */
  sever(threadId: string): { releasedWaiter: boolean } | undefined {
    const state = this.states.get(threadId);
    if (!state) return undefined;
    const head = state.waiters.shift();
    if (head) head.release();
    else state.tail = Promise.resolve();
    return { releasedWaiter: Boolean(head) };
  }
}
