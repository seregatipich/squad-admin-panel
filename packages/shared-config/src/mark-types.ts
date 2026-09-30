/**
 * Mark-type constants shared by the API (request validation) and the web
 * settings page (form options), so the two cannot drift apart.
 */

/** Icon names a mark type may use; matches the icon set the panel UI renders. */
export const MARK_TYPE_ICONS = [
  'scan-eye',
  'crosshair',
  'gauge',
  'boxes',
  'refresh-cw',
  'skull',
  'file-warning',
  'message-square-warning',
  'flag',
  'shield-alert',
  'bug',
  'ban',
  'alert-triangle',
  'eye-off',
  'radar',
  'zap',
] as const;

export type MarkTypeIcon = (typeof MARK_TYPE_ICONS)[number];

/** Inclusive severity bounds of a mark type. */
export const MARK_TYPE_SEVERITY_MIN = 1;
export const MARK_TYPE_SEVERITY_MAX = 5;
