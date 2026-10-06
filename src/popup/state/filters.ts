/**
 * Synced-history state — the downloads-view section fed by `download_sync.js`
 * (spec §5 Phase 5).
 *
 * It was a pair of loose fields on the old store read by `popup_sync_history.js`,
 * which then rebuilt the whole section imperatively on every render. This module now
 * holds only the two live signals the popup reads; the five-entry preview cap and its
 * two derived values were never consumed by any component and were removed.
 */
import { signal } from "@preact/signals";

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

export const syncedHistory = signal<SyncEntry[]>([]);
export const syncInfo = signal<SyncInfo>({ ...DEFAULT_SYNC_INFO });
