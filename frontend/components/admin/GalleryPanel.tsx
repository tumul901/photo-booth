"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import GalleryCard, { GalleryItem } from './GalleryCard';
import DeleteAllDialog from './DeleteAllDialog';
import LightboxModal from './LightboxModal';
import styles from './GalleryPanel.module.css';

interface GalleryPanelProps {
  apiBaseUrl: string;
  active: boolean;
  onCountUpdate?: (count: number) => void;
}

const PAGE_SIZE = 50;

export default function GalleryPanel({ apiBaseUrl, active, onCountUpdate }: GalleryPanelProps) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [templateFilter, setTemplateFilter] = useState<string | null>(null);
  const [templateList, setTemplateList] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [totalActive, setTotalActive] = useState(0);
  const [totalArchived, setTotalArchived] = useState(0);
  const [isVisible, setIsVisible] = useState(true);

  const sentinelRef = useRef<HTMLDivElement>(null);

  // Refs for stable access inside callbacks/observers without adding to deps
  const loadingRef = useRef(false);
  loadingRef.current = loading;
  const loadingMoreRef = useRef(false);
  loadingMoreRef.current = loadingMore;
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = cursor;

  // Track browser tab visibility
  useEffect(() => {
    const onVisibilityChange = () => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const fetchPage = useCallback(async (opts: { reset?: boolean; nextCursor?: string | null } = {}) => {
    const { reset = false, nextCursor = null } = opts;
    if (reset) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), view });
      if (!reset && nextCursor) params.set('cursor', nextCursor);
      if (templateFilter) params.set('template', templateFilter);

      const res = await fetch(`${apiBaseUrl}/api/admin/gallery?${params}`);
      if (!res.ok) return;
      const data = await res.json();

      if (reset) {
        setItems(data.items);
      } else {
        setItems((prev) => [...prev, ...data.items]);
      }
      setCursor(data.next_cursor ?? null);
      setHasMore(data.has_more ?? false);
      setTotalActive(data.total_active ?? 0);
      setTotalArchived(data.total_archived ?? 0);
      setLastRefresh(new Date());
      onCountUpdate?.(data.total_active ?? 0);
    } catch {
      // silent — auto-refresh should not surface transient errors
    } finally {
      if (reset) setLoading(false);
      else setLoadingMore(false);
    }
  }, [apiBaseUrl, view, templateFilter, onCountUpdate]);

  // Merge-refresh: fetches page 1 and prepends genuinely new items without
  // resetting scroll state or clobbering pages the user has already loaded.
  const refreshLatest = useCallback(async () => {
    if (loadingRef.current || loadingMoreRef.current) return;
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), view });
      if (templateFilter) params.set('template', templateFilter);

      const res = await fetch(`${apiBaseUrl}/api/admin/gallery?${params}`);
      if (!res.ok) return;
      const data = await res.json();

      setItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.output_id));
        const fresh = (data.items as GalleryItem[]).filter((i) => !existingIds.has(i.output_id));
        return fresh.length > 0 ? [...fresh, ...prev] : prev;
      });
      setTotalActive(data.total_active ?? 0);
      setTotalArchived(data.total_archived ?? 0);
      setLastRefresh(new Date());
      onCountUpdate?.(data.total_active ?? 0);
    } catch { /* silent */ }
  }, [apiBaseUrl, view, templateFilter, onCountUpdate]);

  const fetchTemplateList = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/gallery/templates`);
      if (!res.ok) return;
      const data = await res.json();
      setTemplateList(data.templates ?? []);
    } catch { /* ignore */ }
  }, [apiBaseUrl]);

  // Initial load + reset when filter/view change.
  // fetchPage identity changes when view or templateFilter change, so this
  // correctly triggers a hard reset on filter switches.
  useEffect(() => {
    if (!active) return;
    fetchPage({ reset: true });
    fetchTemplateList();
  }, [active, fetchPage, fetchTemplateList]);

  // Auto-refresh: 5-second merge-only interval.
  // Paused during selection/bulk ops and when the tab is hidden.
  // Visibility changes only affect whether the interval runs — they do NOT
  // trigger a hard reset (which would lose the user's scroll position).
  useEffect(() => {
    if (!active || selectionMode || bulkBusy || !isVisible) return;
    const id = setInterval(refreshLatest, 5000);
    return () => clearInterval(id);
  }, [active, selectionMode, bulkBusy, isVisible, refreshLatest]);

  // Infinite scroll sentinel.
  // Cursor is read via ref so cursor changes don't reconnect the observer
  // (which previously caused a double-fire when a new page arrived).
  // Loading state is also checked via refs to block mid-reset triggers.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMoreRef.current && !loadingRef.current) {
          fetchPage({ nextCursor: cursorRef.current });
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, fetchPage]);

  // --- Selection helpers ---
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  // --- Bulk operations ---
  const bulkPost = async (endpoint: string, ids: string[]) => {
    setBulkBusy(true);
    try {
      await fetch(`${apiBaseUrl}/api/admin/gallery/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      exitSelection();
      fetchPage({ reset: true });
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkArchive = () => bulkPost('archive', Array.from(selectedIds));
  const handleBulkUnarchive = () => bulkPost('unarchive', Array.from(selectedIds));

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selectedIds.size} photo${selectedIds.size !== 1 ? 's' : ''}?`)) return;
    setBulkBusy(true);
    try {
      await fetch(`${apiBaseUrl}/api/admin/gallery/bulk`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      exitSelection();
      fetchPage({ reset: true });
    } finally {
      setBulkBusy(false);
    }
  };

  const handleDeleteAll = async () => {
    setBulkBusy(true);
    try {
      await fetch(`${apiBaseUrl}/api/admin/gallery/all`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'delete' }),
      });
      setShowDeleteAll(false);
      fetchPage({ reset: true });
    } finally {
      setBulkBusy(false);
    }
  };

  const handleArchiveSingle = async (outputId: string) => {
    await fetch(`${apiBaseUrl}/api/admin/gallery/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [outputId] }),
    });
    setItems((prev) => prev.filter((i) => i.output_id !== outputId));
    setTotalActive((n) => Math.max(0, n - 1));
    setTotalArchived((n) => n + 1);
    onCountUpdate?.(Math.max(0, totalActive - 1));
  };

  const handleUnarchiveSingle = async (outputId: string) => {
    await fetch(`${apiBaseUrl}/api/admin/gallery/unarchive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [outputId] }),
    });
    setItems((prev) => prev.filter((i) => i.output_id !== outputId));
    setTotalArchived((n) => Math.max(0, n - 1));
    setTotalActive((n) => n + 1);
    onCountUpdate?.(totalActive + 1);
  };

  const handleDeleteSingle = async (outputId: string) => {
    if (!confirm('Delete this photo from storage?')) return;
    await fetch(`${apiBaseUrl}/api/admin/gallery/${outputId}`, { method: 'DELETE' });
    setItems((prev) => prev.filter((i) => i.output_id !== outputId));
    setTotalActive((n) => Math.max(0, n - 1));
    onCountUpdate?.(Math.max(0, totalActive - 1));
  };

  const handleLightboxDelete = async (outputId: string) => {
    await fetch(`${apiBaseUrl}/api/admin/gallery/${outputId}`, { method: 'DELETE' });
    setItems((prev) => prev.filter((i) => i.output_id !== outputId));
    setTotalActive((n) => Math.max(0, n - 1));
    onCountUpdate?.(Math.max(0, totalActive - 1));
    // Stay at same index (next item shifts in) or close if last
    setLightboxIndex((idx) => {
      if (idx === null) return null;
      const remaining = items.length - 1;
      if (remaining === 0) return null;
      return Math.min(idx, remaining - 1);
    });
  };

  const handleBulkDownload = () => {
    const ids = Array.from(selectedIds);
    if (ids.length > 10) {
      alert('Select 10 or fewer photos to download at once.');
      return;
    }
    ids.forEach((id, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = `${apiBaseUrl}/api/download/${id}`;
        a.download = id;
        a.click();
      }, i * 150);
    });
  };

  const selCount = selectedIds.size;
  const isArchiveView = view === 'archived';
  const displayCount = isArchiveView ? totalArchived : totalActive;

  return (
    <div>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <h2 className={styles.title}>
            Output Gallery
            {totalActive > 0 && <span className={styles.countBadge}>{totalActive}</span>}
          </h2>
          <span className={styles.subtitle}>
            {loading ? 'Refreshing…' : `${displayCount} photo${displayCount !== 1 ? 's' : ''}`}
            {lastRefresh && !loading && (
              <span className={styles.refreshTime}> · refreshed just now</span>
            )}
          </span>
        </div>

        <div className={styles.toolbarRight}>
          {/* View toggle */}
          <div className={styles.viewToggle}>
            <button
              className={`${styles.toggleBtn} ${!isArchiveView ? styles.toggleActive : ''}`}
              onClick={() => { setView('active'); exitSelection(); }}
            >
              Active
            </button>
            <button
              className={`${styles.toggleBtn} ${isArchiveView ? styles.toggleActive : ''}`}
              onClick={() => { setView('archived'); exitSelection(); }}
            >
              Archived {totalArchived > 0 && <span className={styles.smallBadge}>{totalArchived}</span>}
            </button>
          </div>

          {/* Template filter */}
          {templateList.length > 0 && (
            <select
              className={styles.filterSelect}
              value={templateFilter ?? ''}
              onChange={(e) => { setTemplateFilter(e.target.value || null); exitSelection(); }}
            >
              <option value="">All templates</option>
              {templateList.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}

          {/* Selection mode controls */}
          {!selectionMode ? (
            <button className={styles.btnOutline} onClick={() => setSelectionMode(true)}>
              Select
            </button>
          ) : (
            <div className={styles.selectionBar}>
              <span className={styles.selCount}>{selCount} selected</span>
              <button className={styles.btnSmall} onClick={handleBulkDownload} disabled={selCount === 0 || bulkBusy}>
                Download
              </button>
              {!isArchiveView && (
                <button className={styles.btnSmall} onClick={handleBulkArchive} disabled={selCount === 0 || bulkBusy}>
                  Archive
                </button>
              )}
              {isArchiveView && (
                <button className={styles.btnSmall} onClick={handleBulkUnarchive} disabled={selCount === 0 || bulkBusy}>
                  Restore
                </button>
              )}
              <button className={`${styles.btnSmall} ${styles.btnDangerSmall}`} onClick={handleBulkDelete} disabled={selCount === 0 || bulkBusy}>
                Delete
              </button>
              <button className={styles.btnOutline} onClick={exitSelection} disabled={bulkBusy}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className={styles.grid}>
        {items.map((item, idx) => (
          <GalleryCard
            key={item.output_id}
            item={item}
            selectionMode={selectionMode}
            selected={selectedIds.has(item.output_id)}
            onToggleSelect={toggleSelect}
            onDelete={handleDeleteSingle}
            onArchive={handleArchiveSingle}
            onUnarchive={handleUnarchiveSingle}
            onOpen={() => setLightboxIndex(idx)}
          />
        ))}
      </div>

      {/* Infinite scroll sentinel */}
      <div ref={sentinelRef} className={styles.sentinel} />

      {loadingMore && <p className={styles.loadingMore}>Loading more…</p>}

      {!loading && items.length === 0 && (
        <p className={styles.empty}>
          {isArchiveView ? 'No archived photos.' : 'No photos yet. Generate some to see them here!'}
        </p>
      )}

      {/* Danger zone */}
      {!selectionMode && !isArchiveView && totalActive > 0 && (
        <div className={styles.dangerZone}>
          <span className={styles.dangerLabel}>Danger zone</span>
          <button className={styles.btnDangerOutline} onClick={() => setShowDeleteAll(true)}>
            Delete All Photos
          </button>
        </div>
      )}

      {showDeleteAll && (
        <DeleteAllDialog
          totalCount={totalActive}
          onConfirm={handleDeleteAll}
          onCancel={() => setShowDeleteAll(false)}
          busy={bulkBusy}
        />
      )}

      {lightboxIndex !== null && (
        <LightboxModal
          items={items}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onDelete={handleLightboxDelete}
        />
      )}
    </div>
  );
}
