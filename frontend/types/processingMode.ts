/**
 * The booth's processing modes — one definition, imported everywhere.
 *
 * This union used to be hand-copied into eight files. Adding "cartoon" meant
 * finding all eight, and missing some of them broke the build in places with no
 * obvious connection to the change. Adding a mode should be a one-line edit
 * here, with the compiler pointing at anything that needs to handle it.
 *
 * Values must match the `processing_mode` strings the backend accepts in
 * api/generate.py, and the `templateType` values in templates/*.json.
 */
export type ProcessingMode =
  | 'frame'
  | 'sticker'
  | 'word_template'
  | 'magazine'
  | 'cartoon'
  | 'watercolor';

/**
 * Modes that render a stylised portrait into the neon triangle frame.
 *
 * These share a capture flow: a live frame overlay the guest composes against,
 * a locked aspect ratio, and no manual placement step — the guest's framing IS
 * the placement, so offering to adjust it afterwards would misalign the artwork
 * from the guide they lined up with.
 */
export const ARTWORK_MODES: readonly ProcessingMode[] = ['cartoon', 'watercolor'] as const;

export function isArtworkMode(mode?: ProcessingMode | string | null): boolean {
  return !!mode && ARTWORK_MODES.includes(mode as ProcessingMode);
}
