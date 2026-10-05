/**
 * Synced-history state — the downloads-view section fed by `download_sync.js`
 * (spec §5 Phase 5).
 *
 * It was a pair of loose fields on the old store read by `popup_sync_history.js`,
 * which then rebuilt the whole section imperatively on every render. The cap of five
 * entries is a *display* rule, so it lives here as a derived value rather than being
 * re-implemented in the component.
 */
import { computed, signal } from "@preact/signals";

export interface SyncEntry {
  title?: string;
  url?: string;
  format?: string;
  status?: string;
  sourceHost?: string;
  totalSize?: string;
  completedAt?: number | string;
}

export interface SyncInfo {
  totalCount: number;
  isSyncing: boolean;
  syncEnabled: boolean;
}

export const DEFAULT_SYNC_INFO: SyncInfo = { totalCount: 0, isSyncing: false, syncEnabled: true };

/** How many entries the section shows before its "+N more" line. */
export const SYNC_HISTORY_PREVIEW = 5;

export const syncedHistory = signal<SyncEntry[]>([]);
export const syncInfo = signal<SyncInfo>({ ...DEFAULT_SYNC_INFO });

export const syncedEntries = computed<SyncEntry[]>(() => syncedHistory.value.slice(0, SYNC_HISTORY_PREVIEW));

export const syncedOverflow = computed<number>(() => Math.max(0, syncedHistory.value.length - SYNC_HISTORY_PREVIEW));
