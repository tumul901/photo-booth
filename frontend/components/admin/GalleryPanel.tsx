"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import DeleteAllDialog from './DeleteAllDialog';
import LightboxModal from './LightboxModal';
import QRModal from './QRModal';
import styles from './GalleryPanel.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GalleryItem {
  output_id: string;
  filename: string;
  url: string;
  download_url: string;
  size: number;
  last_modified: string | number;
  created_at?: string;
  template_prefix: string;
  mode: string;
  guest_name: string;
  guest_phone: string;
  archived: boolean;
  downloaded_at: string | null;
}

interface Section {
  date: string;    // 'today' | 'yesterday' | 'DD/MM/YYYY'
  count: number;
  downloaded: number;
  total: number;   // all statuses combined (for ZIP picker)
}

type TabId = 'active' | 'downloaded' | 'archived';

interface GalleryPanelProps {
  apiBaseUrl: string;
  active: boolean;
  onCountUpdate?: (count: number) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(ts: string | number | null | undefined): string {
  if (!ts) return '';
  const d = typeof ts === 'string' ? new Date(ts) : new Date(ts * 1000);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function sectionLabel(date: string): string {
  if (date === 'today') return 'Today';
  if (date === 'yesterday') return 'Yesterday';
  return date;
}

const POLL_INTERVAL = 10_000;
const PAGE_SIZE = 75;
const LS_PREFIX = 'gallery_open_';
const LS_TTL = 7 * 24 * 3600 * 1000;

function readOpenSections(tab: TabId): Set<string> {
  try {
    const raw = localStorage.getItem(LS_PREFIX + tab);
    if (!raw) return new Set();
    const { ts, dates } = JSON.parse(raw);
    if (Date.now() - ts > LS_TTL) return new Set();
    return new Set(dates as string[]);
  } catch { return new Set(); }
}

function writeOpenSections(tab: TabId, open: Set<string>) {
  try {
    localStorage.setItem(LS_PREFIX + tab, JSON.stringify({ ts: Date.now(), dates: [...open] }));
  } catch {}
}

// ── Downloaded badge ──────────────────────────────────────────────────────────

function DownloadedBadge({ downloadedAt }: { downloadedAt: string | null }) {
  if (!downloadedAt) return null;
  const label = `Downloaded ${timeAgo(downloadedAt)}`;
  return (
    <span
      className={styles.downloadedBadge}
      title={downloadedAt}
      aria-label={label}
    />
  );
}

// ── Photo card ────────────────────────────────────────────────────────────────

interface CardProps {
  item: GalleryItem;
  index: number;
  tab: TabId;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onOpen: (idx: number) => void;
  onMarkDownloaded: (id: string) => void;
  onUnmarkDownloaded: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  onShowQR: (item: GalleryItem) => void;
}

function PhotoCard({
  item, index, tab, selectionMode, selected,
  onToggleSelect, onOpen,
  onMarkDownloaded, onUnmarkDownloaded,
  onArchive, onUnarchive, onDelete, onShowQR,
}: CardProps) {
  const isDownloaded = !!item.downloaded_at;

  return (
    <div
      className={`${styles.card} ${selected ? styles.cardSelected : ''}`}
      onClick={() => selectionMode ? onToggleSelect(item.output_id) : onOpen(index)}
      role={selectionMode ? 'checkbox' : 'button'}
      aria-checked={selectionMode ? selected : undefined}
    >
      <div className={styles.imageWrapper}>
        {/* Index badge */}
        <span className={styles.indexBadge}>#{String(index + 1).padStart(2, '0')}</span>

        <img
          src={item.url}
          alt={item.guest_name || item.filename}
          className={styles.image}
          loading="lazy"
          decoding="async"
        />

        {/* Downloaded badge (bottom-right) */}
        <DownloadedBadge downloadedAt={item.downloaded_at} />

        {/* Selection checkbox (top-right) */}
        {selectionMode && (
          <div className={`${styles.checkbox} ${selected ? styles.checkboxChecked : ''}`}>
            {selected && '✓'}
          </div>
        )}

        {/* Delete hover button (top-right, non-selection) */}
        {!selectionMode && (
          <button
            className={styles.deleteOverlay}
            onClick={(e) => { e.stopPropagation(); onDelete(item.output_id); }}
            title="Delete photo"
          >🗑️</button>
        )}
      </div>

      {/* Card info row */}
      <div className={styles.cardInfo}>
        <div className={styles.cardInfoLeft}>
          {item.guest_name ? (
            <span className={styles.guestName}>{item.guest_name}</span>
          ) : (
            <span className={styles.timestamp} title={String(item.created_at || item.last_modified)}>
              {timeAgo(item.created_at || item.last_modified)}
            </span>
          )}
          {item.guest_name && (
            <span className={styles.timestamp} title={String(item.created_at || item.last_modified)}>
              {timeAgo(item.created_at || item.last_modified)}
            </span>
          )}
        </div>

        <div className={styles.cardActions}>
          {/* Download (operator — marks photo) */}
          <a
            href={item.download_url || `${item.url}?source=app`}
            download={item.filename}
            className={styles.actionBtn}
            onClick={(e) => { e.stopPropagation(); onMarkDownloaded(item.output_id); }}
            title="Download (marks as handed over)"
          >↓</a>

          {/* QR */}
          <button
            className={styles.actionBtn}
            onClick={(e) => { e.stopPropagation(); onShowQR(item); }}
            title="Show QR code for customer"
          >QR</button>

          {/* Status actions — contextual per tab */}
          {tab === 'active' && !isDownloaded && (
            <button
              className={styles.actionBtnMark}
              onClick={(e) => { e.stopPropagation(); onMarkDownloaded(item.output_id); }}
              title="Mark as downloaded"
            >✓</button>
          )}
          {(tab === 'active' || tab === 'downloaded') && isDownloaded && (
            <button
              className={styles.actionBtn}
              onClick={(e) => { e.stopPropagation(); onUnmarkDownloaded(item.output_id); }}
              title="Unmark downloaded"
            >✕</button>
          )}
          {tab !== 'archived' && (
            <button
              className={styles.archiveBtn}
              onClick={(e) => { e.stopPropagation(); onArchive(item.output_id); }}
              title="Archive"
            >Arch</button>
          )}
          {tab === 'archived' && (
            <button
              className={styles.unarchiveBtn}
              onClick={(e) => { e.stopPropagation(); onUnarchive(item.output_id); }}
              title="Restore"
            >Restore</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Date section ──────────────────────────────────────────────────────────────

interface SectionProps {
  section: Section;
  tab: TabId;
  isOpen: boolean;
  onToggle: () => void;
  items: GalleryItem[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  globalOffset: number;
  onOpen: (globalIdx: number) => void;
  onMarkDownloaded: (id: string) => void;
  onUnmarkDownloaded: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  onShowQR: (item: GalleryItem) => void;
  onSectionMarkAll: () => void;
  onSectionUnmarkAll: () => void;
  onSectionDownloadZip: () => void;
}

function DateSection({
  section, tab, isOpen, onToggle,
  items, loading, hasMore, onLoadMore,
  selectionMode, selectedIds, onToggleSelect, onSelectAll, onDeselectAll,
  globalOffset, onOpen,
  onMarkDownloaded, onUnmarkDownloaded,
  onArchive, onUnarchive, onDelete, onShowQR,
  onSectionMarkAll, onSectionUnmarkAll, onSectionDownloadZip,
}: SectionProps) {
  const label = sectionLabel(section.date);
  const allSelected = items.length > 0 && items.every(i => selectedIds.has(i.output_id));
  const someSelected = items.some(i => selectedIds.has(i.output_id));
  const triState: 'none' | 'some' | 'all' = allSelected ? 'all' : someSelected ? 'some' : 'none';

  const [showOverflow, setShowOverflow] = useState(false);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        {/* Tri-state checkbox (selection mode) */}
        {selectionMode && isOpen && (
          <button
            className={`${styles.sectionCheckbox} ${triState !== 'none' ? styles.sectionCheckboxActive : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              triState === 'all' ? onDeselectAll() : onSelectAll();
            }}
            title={triState === 'all' ? 'Deselect all in section' : 'Select all in section'}
          >
            {triState === 'all' ? '✓' : triState === 'some' ? '–' : ''}
          </button>
        )}

        <span className={styles.chevron}>{isOpen ? '▾' : '▸'}</span>
        <span className={styles.sectionLabel}>{label}</span>
        <span className={styles.sectionCount}>
          {section.count} photo{section.count !== 1 ? 's' : ''}
          {section.downloaded > 0 && (
            <span className={styles.sectionDownloaded}> · {section.downloaded} handed over</span>
          )}
        </span>

        {/* Section bulk actions (visible when open, outside selection mode) */}
        {isOpen && !selectionMode && (
          <div className={styles.sectionActions} onClick={(e) => e.stopPropagation()}>
            {tab !== 'archived' && (
              <button className={styles.sectionBtn} onClick={onSectionDownloadZip} title="Download all as ZIP">ZIP</button>
            )}
            <div className={styles.overflowWrap}>
              <button className={styles.sectionBtn} onClick={() => setShowOverflow(v => !v)}>⋯</button>
              {showOverflow && (
                <div className={styles.overflowMenu} onMouseLeave={() => setShowOverflow(false)}>
                  {tab !== 'archived' && (
                    <button onClick={() => { onSectionMarkAll(); setShowOverflow(false); }}>Mark all as downloaded</button>
                  )}
                  {(tab === 'active' || tab === 'downloaded') && (
                    <button onClick={() => { onSectionUnmarkAll(); setShowOverflow(false); }}>Unmark all</button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {isOpen && (
        <div className={styles.sectionBody}>
          {items.length === 0 && !loading && (
            <p className={styles.sectionEmpty}>No photos {label.toLowerCase()}.</p>
          )}

          <div className={styles.grid}>
            {items.map((item, i) => (
              <PhotoCard
                key={item.output_id}
                item={item}
                index={globalOffset + i}
                tab={tab}
                selectionMode={selectionMode}
                selected={selectedIds.has(item.output_id)}
                onToggleSelect={onToggleSelect}
                onOpen={onOpen}
                onMarkDownloaded={onMarkDownloaded}
                onUnmarkDownloaded={onUnmarkDownloaded}
                onArchive={onArchive}
                onUnarchive={onUnarchive}
                onDelete={onDelete}
                onShowQR={onShowQR}
              />
            ))}
          </div>

          {hasMore && !loading && (
            <button className={styles.loadMoreBtn} onClick={onLoadMore}>
              Load more in {label} ({section.count - items.length} remaining)
            </button>
          )}
          {loading && <p className={styles.loadingMore}>Loading…</p>}
        </div>
      )}
    </div>
  );
}

// ── ZIP scope picker modal ────────────────────────────────────────────────────

interface ZipPickerModalProps {
  label: string;
  notHandedOver: number;
  allActive: number;
  everything: number;
  currentTab: TabId;
  onConfirm: (status: string) => void;
  onCancel: () => void;
}

function ZipPickerModal({ label, notHandedOver, allActive, everything, currentTab, onConfirm, onCancel }: ZipPickerModalProps) {
  // Default scope: whatever makes most sense for the current tab
  const defaultScope = currentTab === 'archived' ? 'archived' : (notHandedOver > 0 ? 'pending' : currentTab);
  const [scope, setScope] = useState<string>(defaultScope);

  const options: { value: string; label: string; count: number; hint?: string }[] = [];

  if (currentTab !== 'archived') {
    if (notHandedOver > 0) {
      options.push({ value: 'pending', label: 'Not yet handed over', count: notHandedOver, hint: 'Excludes already-downloaded photos' });
    }
    options.push({ value: currentTab, label: currentTab === 'downloaded' ? 'Downloaded only' : 'All active', count: allActive });
  }

  if (everything > allActive) {
    options.push({ value: 'all', label: 'Everything (incl. archived)', count: everything, hint: 'Full date backup' });
  } else if (currentTab === 'archived') {
    options.push({ value: 'archived', label: 'Archived photos', count: allActive });
    if (everything > allActive) {
      options.push({ value: 'all', label: 'Everything', count: everything });
    }
  }

  // 'pending' is a first-class status on the backend (archived=0 AND downloaded_at IS NULL)
  const backendStatus = (s: string) => s;

  return (
    <div className={styles.dialogOverlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.dialogTitle} style={{ color: '#a5b4fc' }}>
          ZIP — {label}
        </h3>
        <p className={styles.dialogBody} style={{ marginBottom: '0.25rem' }}>
          Choose which photos to include:
        </p>

        <div className={styles.zipOptions}>
          {options.map(opt => (
            <label key={opt.value} className={`${styles.zipOption} ${scope === opt.value ? styles.zipOptionSelected : ''}`}>
              <input
                type="radio"
                name="zip-scope"
                value={opt.value}
                checked={scope === opt.value}
                onChange={() => setScope(opt.value)}
                style={{ display: 'none' }}
              />
              <div className={styles.zipOptionDot}>
                {scope === opt.value && <div className={styles.zipOptionDotFill} />}
              </div>
              <div className={styles.zipOptionText}>
                <span className={styles.zipOptionLabel}>{opt.label}</span>
                {opt.hint && <span className={styles.zipOptionHint}>{opt.hint}</span>}
              </div>
              <span className={styles.zipOptionCount}>{opt.count}</span>
            </label>
          ))}
        </div>

        <div className={styles.dialogActions}>
          <button className={styles.btnSecondary} onClick={onCancel}>Cancel</button>
          <button
            className={styles.btnPrimary}
            onClick={() => onConfirm(backendStatus(scope))}
          >
            Download ZIP
          </button>
        </div>
      </div>
    </div>
  );
}

// ── QR Modal ──────────────────────────────────────────────────────────────────
// Defined in QRModal.tsx; imported at top.

// ── Main GalleryPanel ─────────────────────────────────────────────────────────

export default function GalleryPanel({ apiBaseUrl, active, onCountUpdate }: GalleryPanelProps) {
  const [tab, setTab] = useState<TabId>('active');
  const [sections, setSections] = useState<Section[]>([]);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [sectionItems, setSectionItems] = useState<Record<string, GalleryItem[]>>({});
  const [sectionOffset, setSectionOffset] = useState<Record<string, number>>({});
  const [sectionHasMore, setSectionHasMore] = useState<Record<string, boolean>>({});
  const [sectionLoading, setSectionLoading] = useState<Record<string, boolean>>({});
  const [tabCounts, setTabCounts] = useState({ active: 0, downloaded: 0, archived: 0 });

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<GalleryItem[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showDeleteAll, setShowDeleteAll] = useState(false);
  // deleteConfirm: null = no dialog; set to show the custom confirm dialog
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: string[]; label: string; onConfirm: () => Promise<void> } | null>(null);
  // zipStatus: null = idle; set while a ZIP is being generated/downloaded
  const [zipStatus, setZipStatus] = useState<{ count: number; filename: string } | null>(null);
  // zipPicker: open the pre-flight scope picker before starting a section ZIP
  const [zipPicker, setZipPicker] = useState<{ section: Section } | null>(null);
  const [lightboxItems, setLightboxItems] = useState<GalleryItem[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [qrItem, setQrItem] = useState<GalleryItem | null>(null);

  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [isVisible, setIsVisible] = useState(true);

  const abortRefs = useRef<Record<string, AbortController>>({});

  // ── Visibility tracking ───────────────────────────────────────────────────

  useEffect(() => {
    const handler = () => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // ── Section list fetch ────────────────────────────────────────────────────

  const fetchSections = useCallback(async (tabOverride?: TabId) => {
    const t = tabOverride ?? tab;
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/gallery/sections?status=${t}`);
      if (!res.ok) return;
      const data = await res.json();
      setSections(data.sections ?? []);
      setTabCounts({
        active: data.total_active ?? 0,
        downloaded: data.total_downloaded ?? 0,
        archived: data.total_archived ?? 0,
      });
      setLastRefresh(new Date());
      onCountUpdate?.(data.total_active ?? 0);
    } catch {}
  }, [apiBaseUrl, tab, onCountUpdate]);

  // ── Per-section photo fetch ───────────────────────────────────────────────

  const fetchSection = useCallback(async (date: string, reset = false) => {
    const offset = reset ? 0 : (sectionOffset[date] ?? 0);

    // Abort any in-flight request for this section
    abortRefs.current[date]?.abort();
    const ctrl = new AbortController();
    abortRefs.current[date] = ctrl;

    setSectionLoading(prev => ({ ...prev, [date]: true }));
    try {
      const params = new URLSearchParams({
        status: tab,
        date,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const res = await fetch(`${apiBaseUrl}/api/admin/gallery?${params}`, { signal: ctrl.signal });
      if (!res.ok) return;
      const data = await res.json();
      const incoming: GalleryItem[] = data.items ?? [];

      setSectionItems(prev => ({
        ...prev,
        [date]: reset ? incoming : [...(prev[date] ?? []), ...incoming],
      }));
      const newOffset = offset + incoming.length;
      setSectionOffset(prev => ({ ...prev, [date]: newOffset }));

      // We have more if we got a full page
      const hasMore = incoming.length === PAGE_SIZE;
      setSectionHasMore(prev => ({ ...prev, [date]: hasMore }));
    } catch (e: any) {
      if (e?.name !== 'AbortError') console.error('section fetch failed', e);
    } finally {
      setSectionLoading(prev => ({ ...prev, [date]: false }));
    }
  }, [apiBaseUrl, tab, sectionOffset]);

  // ── Toggle section open/closed ────────────────────────────────────────────

  const toggleSection = useCallback((date: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(date)) {
        next.delete(date);
        abortRefs.current[date]?.abort();
      } else {
        next.add(date);
        // Fetch if we don't have data yet
        fetchSection(date, true);
      }
      writeOpenSections(tab, next);
      return next;
    });
  }, [tab, fetchSection]);

  // ── Tab switch ────────────────────────────────────────────────────────────

  const switchTab = useCallback((t: TabId) => {
    setTab(t);
    setSelectionMode(false);
    setSelectedIds(new Set());
    setSections([]);
    setSectionItems({});
    setSectionOffset({});
    setSectionHasMore({});
    setSearchQ('');
    setSearchResults(null);

    // Restore open sections from localStorage, then fetch section list
    const restored = readOpenSections(t);
    setOpenSections(restored);
  }, []);

  // When tab changes, fetch sections list
  useEffect(() => {
    if (!active) return;
    fetchSections(tab);
  }, [active, tab, fetchSections]);

  // When sections load, auto-expand defaults and fetch any restored-open sections
  useEffect(() => {
    if (!active || sections.length === 0) return;

    setOpenSections(prev => {
      const next = new Set(prev);
      // Default expansion: first section with photos (or 'today' if empty)
      if (next.size === 0) {
        const firstWithPhotos = sections.find(s => s.count > 0);
        const toOpen = firstWithPhotos?.date ?? sections[0]?.date;
        if (toOpen) next.add(toOpen);
      }

      // Fetch data for all open sections that don't have data yet
      next.forEach(date => {
        if (!(date in sectionItems)) fetchSection(date, true);
      });

      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  // ── Polling ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!active || selectionMode || bulkBusy || !isVisible) return;
    const id = setInterval(() => {
      fetchSections();
      // Refresh all open sections
      openSections.forEach(date => fetchSection(date, true));
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [active, selectionMode, bulkBusy, isVisible, fetchSections, fetchSection, openSections]);

  // ── Search ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!searchQ.trim()) { setSearchResults(null); return; }

    searchDebounce.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const params = new URLSearchParams({ q: searchQ, status: tab, limit: '50' });
        const res = await fetch(`${apiBaseUrl}/api/admin/gallery/search?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        setSearchResults(data.items ?? []);
      } catch {} finally {
        setSearchLoading(false);
      }
    }, 300);
  }, [searchQ, tab, apiBaseUrl]);

  // ── Selection helpers ─────────────────────────────────────────────────────

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const exitSelection = () => { setSelectionMode(false); setSelectedIds(new Set()); };

  // ── Optimistic item removal from section state ────────────────────────────

  const removeFromSection = (date: string, id: string) => {
    setSectionItems(prev => ({
      ...prev,
      [date]: (prev[date] ?? []).filter(i => i.output_id !== id),
    }));
  };

  const updateInSection = (date: string, id: string, patch: Partial<GalleryItem>) => {
    setSectionItems(prev => ({
      ...prev,
      [date]: (prev[date] ?? []).map(i => i.output_id === id ? { ...i, ...patch } : i),
    }));
  };

  // Helper: which section does an id live in?
  const findSection = (id: string): string | undefined => {
    for (const [date, items] of Object.entries(sectionItems)) {
      if (items.some(i => i.output_id === id)) return date;
    }
  };

  // ── Per-item actions ──────────────────────────────────────────────────────

  const handleMarkDownloaded = async (id: string) => {
    const date = findSection(id);
    if (date) updateInSection(date, id, { downloaded_at: new Date().toISOString() });
    await fetch(`${apiBaseUrl}/api/admin/gallery/${id}/mark-downloaded`, { method: 'PATCH' });
    fetchSections();
  };

  const handleUnmarkDownloaded = async (id: string) => {
    const date = findSection(id);
    if (date) updateInSection(date, id, { downloaded_at: null });
    await fetch(`${apiBaseUrl}/api/admin/gallery/${id}/unmark-downloaded`, { method: 'PATCH' });
    fetchSections();
  };

  const handleArchive = async (id: string) => {
    const date = findSection(id);
    if (date) removeFromSection(date, id);
    await fetch(`${apiBaseUrl}/api/admin/gallery/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    fetchSections();
  };

  const handleUnarchive = async (id: string) => {
    const date = findSection(id);
    if (date) removeFromSection(date, id);
    await fetch(`${apiBaseUrl}/api/admin/gallery/unarchive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    fetchSections();
  };

  const handleDelete = (id: string) => {
    setDeleteConfirm({
      ids: [id],
      label: 'Delete this photo from storage? This cannot be undone.',
      onConfirm: async () => {
        const date = findSection(id);
        if (date) removeFromSection(date, id);
        await fetch(`${apiBaseUrl}/api/admin/gallery/${id}`, { method: 'DELETE' });
        fetchSections();
      },
    });
  };

  // ── Bulk actions ──────────────────────────────────────────────────────────

  const bulkFetch = async (url: string, method: string, body: object) => {
    setBulkBusy(true);
    try {
      await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      exitSelection();
      fetchSections();
      openSections.forEach(date => fetchSection(date, true));
    } finally { setBulkBusy(false); }
  };

  const handleBulkMarkDownloaded = () =>
    bulkFetch(`${apiBaseUrl}/api/admin/gallery/bulk/mark-downloaded`, 'PATCH', { ids: [...selectedIds] });

  const handleBulkUnmarkDownloaded = () =>
    bulkFetch(`${apiBaseUrl}/api/admin/gallery/bulk/unmark-downloaded`, 'PATCH', { ids: [...selectedIds] });

  const handleBulkArchive = () =>
    bulkFetch(`${apiBaseUrl}/api/admin/gallery/archive`, 'POST', { ids: [...selectedIds] });

  const handleBulkUnarchive = () =>
    bulkFetch(`${apiBaseUrl}/api/admin/gallery/unarchive`, 'POST', { ids: [...selectedIds] });

  const handleBulkDelete = () => {
    const ids = [...selectedIds];
    setDeleteConfirm({
      ids,
      label: `Delete ${ids.length} photo${ids.length !== 1 ? 's' : ''} from storage? This cannot be undone.`,
      onConfirm: () => bulkFetch(`${apiBaseUrl}/api/admin/gallery/bulk`, 'DELETE', { ids }),
    });
  };

  const handleBulkZip = async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const filename = 'photobooth-photos.zip';
    setBulkBusy(true);
    setZipStatus({ count: ids.length, filename });
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/gallery/zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) { alert('ZIP failed'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      exitSelection();
      fetchSections();
    } finally { setBulkBusy(false); setZipStatus(null); }
  };

  // ── Section-level actions ─────────────────────────────────────────────────

  const handleSectionMarkAll = async (date: string) => {
    const ids = (sectionItems[date] ?? []).map(i => i.output_id);
    if (!ids.length) return;
    await fetch(`${apiBaseUrl}/api/admin/gallery/bulk/mark-downloaded`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    fetchSection(date, true);
    fetchSections();
  };

  const handleSectionUnmarkAll = async (date: string) => {
    const ids = (sectionItems[date] ?? []).map(i => i.output_id);
    if (!ids.length) return;
    await fetch(`${apiBaseUrl}/api/admin/gallery/bulk/unmark-downloaded`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    fetchSection(date, true);
    fetchSections();
  };

  // Shared ZIP executor — called by both the picker and bulk ZIP
  const executeZip = async (opts: { date: string; status: string; count: number }) => {
    const filename = `photobooth-${opts.date}.zip`;
    setBulkBusy(true);
    setZipPicker(null);
    setZipStatus({ count: opts.count, filename });
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/gallery/zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: opts.date, status: opts.status }),
      });
      if (!res.ok) { alert('ZIP failed'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      fetchSection(opts.date, true);
      fetchSections();
    } finally { setBulkBusy(false); setZipStatus(null); }
  };

  const handleSectionZip = (date: string) => {
    const section = sections.find(s => s.date === date);
    if (!section || section.count === 0) return;
    // Open the scope picker so the operator can choose which subset to zip
    setZipPicker({ section });
  };

  // ── Delete All ────────────────────────────────────────────────────────────

  const handleDeleteAll = async () => {
    setBulkBusy(true);
    try {
      await fetch(`${apiBaseUrl}/api/admin/gallery/all`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'delete' }),
      });
      setShowDeleteAll(false);
      setSectionItems({});
      fetchSections();
    } finally { setBulkBusy(false); }
  };

  // ── Lightbox ──────────────────────────────────────────────────────────────

  const handleOpen = useCallback((globalIdx: number, allItems: GalleryItem[]) => {
    setLightboxItems(allItems);
    setLightboxIndex(globalIdx);
  }, []);

  const handleLightboxDelete = async (id: string) => {
    await fetch(`${apiBaseUrl}/api/admin/gallery/${id}`, { method: 'DELETE' });
    const date = findSection(id);
    if (date) removeFromSection(date, id);
    setLightboxItems(prev => prev.filter(i => i.output_id !== id));
    setLightboxIndex(prev => {
      if (prev === null) return null;
      const remaining = lightboxItems.length - 1;
      return remaining === 0 ? null : Math.min(prev, remaining - 1);
    });
    fetchSections();
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Flatten items across open sections for lightbox navigation
  const allOpenItems = sections.flatMap(s => isOpen(s.date) ? (sectionItems[s.date] ?? []) : []);
  function isOpen(date: string) { return openSections.has(date); }

  const selCount = selectedIds.size;
  const isSearching = searchQ.trim().length > 0;

  return (
    <div className={styles.galleryRoot}>
      {/* ── Tab bar ── */}
      <div className={styles.tabBar}>
        {(['active', 'downloaded', 'archived'] as TabId[]).map(t => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => switchTab(t)}
          >
            {t === 'active' && `Active (${tabCounts.active}${tabCounts.downloaded > 0 ? ` · ${tabCounts.downloaded} handed over` : ''})`}
            {t === 'downloaded' && `Downloaded (${tabCounts.downloaded})`}
            {t === 'archived' && `Archived (${tabCounts.archived})`}
          </button>
        ))}
      </div>

      {/* ── Toolbar ── */}
      <div className={styles.toolbar}>
        {/* Search */}
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search by name or ID…"
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
        />

        {/* Last refresh indicator */}
        {lastRefresh && !isSearching && (
          <span className={styles.refreshTime}>
            Updated {timeAgo(lastRefresh.toISOString())}
          </span>
        )}

        {/* Selection / bulk action bar */}
        {!selectionMode ? (
          <button className={styles.btnOutline} onClick={() => setSelectionMode(true)}>Select</button>
        ) : (
          <div className={styles.selectionBar}>
            <span className={styles.selCount}>{selCount} selected</span>
            <button className={styles.btnSmall} onClick={handleBulkZip} disabled={selCount === 0 || bulkBusy}>ZIP</button>
            {tab === 'active' && <button className={styles.btnSmall} onClick={handleBulkMarkDownloaded} disabled={selCount === 0 || bulkBusy}>Mark ✓</button>}
            {(tab === 'active' || tab === 'downloaded') && <button className={styles.btnSmall} onClick={handleBulkUnmarkDownloaded} disabled={selCount === 0 || bulkBusy}>Unmark</button>}
            {tab !== 'archived' && <button className={styles.btnSmall} onClick={handleBulkArchive} disabled={selCount === 0 || bulkBusy}>Archive</button>}
            {tab === 'archived' && <button className={styles.btnSmall} onClick={handleBulkUnarchive} disabled={selCount === 0 || bulkBusy}>Restore</button>}
            <button className={`${styles.btnSmall} ${styles.btnDangerSmall}`} onClick={handleBulkDelete} disabled={selCount === 0 || bulkBusy}>Delete</button>
            <button className={styles.btnOutline} onClick={exitSelection} disabled={bulkBusy}>Cancel</button>
          </div>
        )}
      </div>

      {/* ── Search results ── */}
      {isSearching && (
        <div>
          {searchLoading && <p className={styles.loadingMore}>Searching…</p>}
          {!searchLoading && searchResults !== null && (
            searchResults.length === 0
              ? <p className={styles.empty}>No results for &ldquo;{searchQ}&rdquo;</p>
              : <div className={styles.grid}>
                  {searchResults.map((item, i) => (
                    <PhotoCard
                      key={item.output_id}
                      item={item}
                      index={i}
                      tab={tab}
                      selectionMode={false}
                      selected={false}
                      onToggleSelect={() => {}}
                      onOpen={() => { setLightboxItems(searchResults); setLightboxIndex(i); }}
                      onMarkDownloaded={handleMarkDownloaded}
                      onUnmarkDownloaded={handleUnmarkDownloaded}
                      onArchive={handleArchive}
                      onUnarchive={handleUnarchive}
                      onDelete={handleDelete}
                      onShowQR={setQrItem}
                    />
                  ))}
                </div>
          )}
        </div>
      )}

      {/* ── Date sections ── */}
      {!isSearching && (
        <div className={styles.sections}>
          {sections.map(section => {
            const items = sectionItems[section.date] ?? [];
            const open = openSections.has(section.date);

            // Running offset for global lightbox index
            const precedingItems = sections
              .slice(0, sections.indexOf(section))
              .flatMap(s => openSections.has(s.date) ? (sectionItems[s.date] ?? []) : []);

            return (
              <DateSection
                key={section.date}
                section={section}
                tab={tab}
                isOpen={open}
                onToggle={() => toggleSection(section.date)}
                items={items}
                loading={!!sectionLoading[section.date]}
                hasMore={!!sectionHasMore[section.date]}
                onLoadMore={() => fetchSection(section.date)}
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onSelectAll={() => setSelectedIds(prev => new Set([...prev, ...items.map(i => i.output_id)]))}
                onDeselectAll={() => setSelectedIds(prev => { const n = new Set(prev); items.forEach(i => n.delete(i.output_id)); return n; })}
                globalOffset={precedingItems.length}
                onOpen={(idx) => { setLightboxItems(allOpenItems); setLightboxIndex(idx); }}
                onMarkDownloaded={handleMarkDownloaded}
                onUnmarkDownloaded={handleUnmarkDownloaded}
                onArchive={handleArchive}
                onUnarchive={handleUnarchive}
                onDelete={handleDelete}
                onShowQR={setQrItem}
                onSectionMarkAll={() => handleSectionMarkAll(section.date)}
                onSectionUnmarkAll={() => handleSectionUnmarkAll(section.date)}
                onSectionDownloadZip={() => handleSectionZip(section.date)}
              />
            );
          })}
          {sections.length === 0 && (
            <p className={styles.empty}>No photos yet.</p>
          )}
        </div>
      )}

      {/* ── Danger zone ── */}
      {!selectionMode && tab === 'active' && tabCounts.active > 0 && (
        <div className={styles.dangerZone}>
          <span className={styles.dangerLabel}>Danger zone</span>
          <button className={styles.btnDangerOutline} onClick={() => setShowDeleteAll(true)}>
            Delete All Photos
          </button>
        </div>
      )}

      {/* ── Modals ── */}

      {/* ZIP scope picker */}
      {zipPicker && (() => {
        const s = zipPicker.section;
        const label = sectionLabel(s.date);
        // Derive counts for each scope option
        const notHandedOver = s.count - s.downloaded;
        const allActive    = s.count;           // tab's view total (archived=0)
        const everything   = s.total;           // all statuses combined
        return (
          <ZipPickerModal
            label={label}
            notHandedOver={notHandedOver}
            allActive={allActive}
            everything={everything}
            currentTab={tab}
            onConfirm={(status) => {
              const count = status === 'all' ? everything : status === 'pending' ? notHandedOver : allActive;
              executeZip({ date: s.date, status, count });
            }}
            onCancel={() => setZipPicker(null)}
          />
        );
      })()}

      {/* ZIP progress overlay */}
      {zipStatus && (
        <div className={styles.dialogOverlay}>
          <div className={styles.dialog} style={{ gap: '1.25rem' }}>
            <h3 className={styles.dialogTitle} style={{ color: '#a5b4fc' }}>
              Preparing ZIP
            </h3>
            <p className={styles.dialogBody}>
              Packing <strong style={{ color: '#fff' }}>{zipStatus.count}</strong> photo{zipStatus.count !== 1 ? 's' : ''} into{' '}
              <strong style={{ color: '#fff' }}>{zipStatus.filename}</strong>
              <br />
              <span style={{ fontSize: '0.82rem' }}>This may take a few seconds — do not close this tab.</span>
            </p>
            <div className={styles.zipProgressTrack}>
              <div className={styles.zipProgressBar} />
            </div>
          </div>
        </div>
      )}

      {/* Inline delete confirmation — replaces browser confirm() */}
      {deleteConfirm && (
        <div className={styles.dialogOverlay} onClick={() => setDeleteConfirm(null)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.dialogTitle}>Confirm Delete</h3>
            <p className={styles.dialogBody}>{deleteConfirm.label}</p>
            <div className={styles.dialogActions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setDeleteConfirm(null)}
                disabled={bulkBusy}
              >
                Cancel
              </button>
              <button
                className={styles.btnDanger}
                disabled={bulkBusy}
                onClick={async () => {
                  setBulkBusy(true);
                  try { await deleteConfirm.onConfirm(); }
                  finally { setBulkBusy(false); setDeleteConfirm(null); }
                }}
              >
                {bulkBusy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteAll && (
        <DeleteAllDialog
          totalCount={tabCounts.active}
          onConfirm={handleDeleteAll}
          onCancel={() => setShowDeleteAll(false)}
          busy={bulkBusy}
        />
      )}

      {lightboxIndex !== null && lightboxItems.length > 0 && (
        <LightboxModal
          items={lightboxItems}
          index={lightboxIndex}
          onClose={() => { setLightboxIndex(null); setLightboxItems([]); }}
          onNavigate={setLightboxIndex}
          onDelete={handleLightboxDelete}
        />
      )}

      {qrItem && (
        <QRModal
          outputId={qrItem.output_id}
          apiBaseUrl={apiBaseUrl}
          onClose={() => setQrItem(null)}
        />
      )}
    </div>
  );
}
