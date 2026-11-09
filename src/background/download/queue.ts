/** One admitted item: the job it opened, plus the promise that ends its slot. */
export interface QueueSlot {
  jobId: string;
  /** A duplicate was blocked and an in-flight job was reused instead of starting one. */
  existing?: boolean;
  /**
   * Resolves when the download SETTLES — `done`, `error`, `canceled`, the port
   * disconnecting, or a browser-path transfer completing or being interrupted — not when
   * it starts.
   *
   * This is the whole point of the gate. `startNativeDownloadFromVideo` returns the
   * instant the native port is open and the request is posted; the transfer itself runs
   * on a detached `port.onMessage` listener nothing awaits. A queue that released on
   * *start* therefore admitted all 100 items of a big playlist within seconds — 100
   * native ports, and for Spotify ~12 `ytsearch` subprocesses per track on top.
   */
  settled: Promise<void>;
}

/** What {@link createDownloadQueue}'s `add` answers with, synchronously. */
export interface QueueTicket {
  /** Every slot was taken: the item is waiting, and its caller writes the `queued` row. */
  queued: boolean;
  /** Items in front of this one in the wait line; `0` when it was admitted at once. */
  ahead: number;
  /**
   * Resolves once the item has STARTED with its slot, or with `null` when it was withdrawn
   * (cancelled or paused) before a slot opened. Rejects when the starter throws.
   */
  slot: Promise<QueueSlot | null>;
}

/**
 * Starts one item. `waited` is true when it sat in the line first, so the starter can
 * re-check that nobody changed the job's mind in the meantime.
 */
export type QueueStarter = (waited: boolean) => Promise<QueueSlot>;

interface WaitingItem {
  jobId: string;
  start: QueueStarter;
  resolve(slot: QueueSlot | null): void;
  reject(error: unknown): void;
}

/**
 * The one N-at-a-time gate every download start goes through — a single click, a pasted
 * URL, a batch, a retry, a resume, a startup re-admission.
 *
 * `limit` is read on every admission rather than captured, so a changed
 * `maxConcurrentDownloads` takes effect for the next item that gets a slot. Lowering it
 * never stops a running job: the gate just admits nothing until enough have settled.
 *
 * `onWaitingChanged` hears the wait line's job ids, front first, whenever its order
 * moves, which is how `download/index.ts` keeps each row's "N ahead" honest.
 */
export function createDownloadQueue(
  limit: () => number,
  onWaitingChanged: (jobIds: readonly string[]) => void = () => {},
) {
  let active = 0;
  const waiting: WaitingItem[] = [];

  function release(): void {
    active -= 1;
    pump();
  }

  function run(item: WaitingItem, waited: boolean): void {
    active += 1;
    let starting: Promise<QueueSlot>;
    try {
      starting = item.start(waited);
    } catch (error) {
      starting = Promise.reject(error);
    }
    starting.then(
      (slot) => {
        // Both outcomes release: a rejected settle signal is still the end of this job,
        // and leaving the slot held would strand every item behind it.
        slot.settled.then(release, release);
        item.resolve(slot);
      },
      (error: unknown) => {
        // The item never got going, so nothing else will ever release it.
        release();
        item.reject(error);
      },
    );
  }

  function pump(): void {
    let moved = false;
    while (waiting.length && active < limit()) {
      run(waiting.shift() as WaitingItem, true);
      moved = true;
    }
    if (moved) {
      onWaitingChanged(waiting.map((item) => item.jobId));
    }
  }

  function add(jobId: string, start: QueueStarter): QueueTicket {
    let resolve: (slot: QueueSlot | null) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const slot = new Promise<QueueSlot | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const item: WaitingItem = { jobId, start, resolve, reject };
    if (!waiting.length && active < limit()) {
      run(item, false);
      return { queued: false, ahead: 0, slot };
    }
    // Behind the line, never past it — and `pump` still runs, because a raised limit may
    // have left free slots that nothing has released into yet.
    waiting.push(item);
    pump();
    const ahead = waiting.indexOf(item);
    return ahead < 0 ? { queued: false, ahead: 0, slot } : { queued: true, ahead, slot };
  }

  /** Take a waiting item out of the line. `false` when it is not waiting (already started, or unknown). */
  function withdraw(jobId: string): boolean {
    const index = waiting.findIndex((item) => item.jobId === jobId);
    if (index < 0) {
      return false;
    }
    waiting.splice(index, 1)[0].resolve(null);
    onWaitingChanged(waiting.map((item) => item.jobId));
    return true;
  }

  /**
   * Count a transfer the gate did not start — a browser download the startup
   * reconciliation found still running — and return its release, safe to call twice.
   */
  function occupy(): () => void {
    active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        release();
      }
    };
  }

  return { add, withdraw, occupy };
}
