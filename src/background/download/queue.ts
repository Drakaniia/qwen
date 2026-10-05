import type { TabId } from "../types.js";

export type QueueStarter = (tabId: TabId, videoId: string, formatId: string) => Promise<{ jobId: string }>;

/** N-at-a-time starter queue. Failures reject that item only; siblings continue. */
export function createBoundedQueue(limit: number, start: QueueStarter) {
  let active = 0;
  const waiting: Array<() => void> = [];

  async function add(tabId: TabId, videoId: string, formatId: string): Promise<{ jobId: string }> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await start(tabId, videoId, formatId);
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  return { add };
}
