// ── Guest-facing types ─────────────────────────────────────────────────

export interface WordItem {
  id: string;
  label: string;
  // svg_path deliberately omitted — frontend never needs server file paths
}

export interface BundleItem {
  id: string;
  label: string;
  words: string[];
}

export interface WordsPayload {
  template_id: string;
  words: WordItem[];
  bundles: BundleItem[];
  max_selections: number;
  slot_count: number;
  has_name_overlay: boolean;
  has_designation_overlay: boolean;
}

export interface ComposePayload {
  template_id: string;
  selected_words: string[]; // frontend sends unsorted. Backend always sorts.
}

export interface ComposeResult {
  template_path: string;
  cache_hit: boolean;
  compose_time_ms?: number;
}

// ── Shared types ───────────────────────────────────────────────────────

export interface SlotDefinition {
  id: string;
  order: number;
  x: number;        // original image pixels
  y: number;        // original image pixels
  width: number;    // original image pixels
  height: number;   // original image pixels
  rotation: number; // degrees, clockwise positive, default 0
}

export interface PhotoSlotDefinition {
  x: number;
  y: number;
  width: number;
  height: number;
  anchor_x: number;           // relative within slot (0-1), default 0.5
  anchor_y: number;           // relative within slot (0-1), default 0.35
  anchor_mode: 'face_center' | 'eyes' | 'none' | 'full_frame';
  desired_face_ratio: number; // face height as ratio of slot height, e.g. 0.35
  min_zoom: number;           // default 0.5
  max_zoom: number;           // default 3.0
  sticker_filter: 'none' | 'bw' | 'sketch';
}

// ── Admin-only types ───────────────────────────────────────────────────

export interface WTMAssetWord {
  id: string;
  label: string;
  type?: 'asset';
  svg_filename: string;
}

export interface WTMTextWord {
  id: string;
  label: string;
  type: 'text';
  text: string;
  font: string;
  color: string;
  align: 'left' | 'center' | 'right';
}

export type WTMWord = WTMAssetWord | WTMTextWord;

export interface WTMBundle {
  id: string;
  label: string;
  words: string[];
}

export interface TextOverlayConfig {
  x: number;
  y: number;
  font_size: number;
  color: string;
  font_name: string;
  max_width: number;
  align: 'left' | 'center' | 'right';
  uppercase: boolean;
}

export interface WTMTemplateConfig {
  template_id: string;
  name: string;
  mode: 'word_template';
  base_image: string;
  dimensions: { width: number; height: number };
  slots: SlotDefinition[];
  photo_slot: PhotoSlotDefinition | null;
  words: WTMWord[];
  bundles: WTMBundle[];
  max_selections: number;
  allow_manual_positioning: boolean;
  name_text?: TextOverlayConfig | null;
  designation_text?: TextOverlayConfig | null;
  created_at: string;
  updated_at: string;
}

export interface WTMTemplateListItem {
  template_id: string;
  name: string;
  slot_count: number;
  word_count: number;
  created_at: string;
}
