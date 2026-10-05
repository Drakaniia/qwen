import type { TabId } from "../types.js";

/** One admitted item: the job it opened, plus the promise that ends its slot. */
export interface QueueSlot {
  jobId: string;
  /** A duplicate was blocked and an in-flight job was reused instead of starting one. */
  existing?: boolean;
  /**
   * Resolves when the download SETTLES — `done`, `error`, `canceled`, or the port
   * disconnecting — not when it starts.
   *
   * This is the whole point of the gate. `startNativeDownloadFromVideo` returns the
   * instant the native port is open and the request is posted; the transfer itself runs
   * on a detached `port.onMessage` listener nothing awaits. A queue that released on
   * *start* therefore admitted all 100 items of a big playlist within seconds — 100
   * native ports, and for Spotify ~12 `ytsearch` subprocesses per track on top.
   */
  settled: Promise<void>;
}

export type QueueStarter = (tabId: TabId, videoId: string, formatId: string, jobId: string) => Promise<QueueSlot>;

/** N-at-a-time starter queue. Failures reject that item only; siblings continue. */
export function createBoundedQueue(limit: number, start: QueueStarter) {
  let active = 0;
  const waiting: Array<() => void> = [];

  async function add(tabId: TabId, videoId: string, formatId: string, jobId: string): Promise<QueueSlot> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    let slot: QueueSlot;
    try {
      slot = await start(tabId, videoId, formatId, jobId);
    } catch (error) {
      // The item never got a slot, so nothing else will ever release it.
      active -= 1;
      waiting.shift()?.();
      throw error;
    }
    // Both outcomes release: a rejected settle signal is still the end of this job, and
    // leaving the slot held would strand every item behind it.
    const release = (): void => {
      active -= 1;
      waiting.shift()?.();
    };
    slot.settled.then(release, release);
    return slot;
  }

  return { add };
}
