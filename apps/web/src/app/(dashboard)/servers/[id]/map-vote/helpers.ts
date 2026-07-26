/** One candidate row of the GAME-1 map-vote editor, as returned by `GET /map-vote`. */
export interface MapVoteCandidate {
  layer: string;
  map: string | null;
  gamemode: string | null;
  weight: number;
  enabled: boolean;
  deprecated: boolean;
}

/** Editable map-vote settings, camelCase page state for `PUT /map-vote/settings`. */
export interface MapVoteSettingsForm {
  enabled: boolean;
  selection: 'weighted_random' | 'least_recently_played';
  layerCooldown: number;
  mapCooldown: number;
  broadcastTemplate: string;
}

/** Weight must be an integer in 1..100 (mirrors the API/DB constraint). */
export function isValidWeight(weight: number): boolean {
  return Number.isInteger(weight) && weight >= 1 && weight <= 100;
}

/** Cooldowns accept integers 0..20 (mirrors the API schema). */
export function isValidCooldown(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 20;
}

/**
 * Validates the candidate list before `PUT /map-vote/candidates`.
 * Returns a Russian error message, or null when the list is valid.
 */
export function validateCandidates(candidates: readonly MapVoteCandidate[]): string | null {
  for (const candidate of candidates) {
    if (!isValidWeight(candidate.weight)) {
      return `Вес слоя «${candidate.layer}» должен быть целым числом от 1 до 100.`;
    }
  }
  return null;
}

/**
 * Validates the settings form before `PUT /map-vote/settings`.
 * Enabling auto-selection requires at least one candidate.
 */
export function validateSettings(form: MapVoteSettingsForm, candidateCount: number): string | null {
  if (!isValidCooldown(form.layerCooldown) || !isValidCooldown(form.mapCooldown)) {
    return 'Кулдауны должны быть целыми числами от 0 до 20.';
  }
  if (form.broadcastTemplate.length > 300) {
    return 'Шаблон объявления не длиннее 300 символов.';
  }
  if (form.enabled && candidateCount === 0) {
    return 'Нельзя включить автовыбор без кандидатов — добавьте хотя бы один слой.';
  }
  return null;
}

/** Builds the `PUT /map-vote/settings` body (empty template becomes null). */
export function buildSettingsPayload(form: MapVoteSettingsForm): {
  enabled: boolean;
  selection: 'weighted_random' | 'least_recently_played';
  layer_cooldown: number;
  map_cooldown: number;
  broadcast_template: string | null;
} {
  return {
    enabled: form.enabled,
    selection: form.selection,
    layer_cooldown: form.layerCooldown,
    map_cooldown: form.mapCooldown,
    broadcast_template: form.broadcastTemplate.trim() === '' ? null : form.broadcastTemplate,
  };
}

/** Builds the `PUT /map-vote/candidates` body from the current editor rows. */
export function buildCandidatesPayload(
  candidates: readonly MapVoteCandidate[],
  confirmDeprecated: boolean,
): {
  candidates: Array<{ layer: string; weight: number; enabled: boolean }>;
  confirm_deprecated?: boolean;
} {
  const body: {
    candidates: Array<{ layer: string; weight: number; enabled: boolean }>;
    confirm_deprecated?: boolean;
  } = {
    candidates: candidates.map((c) => ({ layer: c.layer, weight: c.weight, enabled: c.enabled })),
  };
  if (confirmDeprecated) body.confirm_deprecated = true;
  return body;
}

/** Appends a catalog layer as a new candidate; duplicates are ignored. */
export function addCandidate(
  candidates: readonly MapVoteCandidate[],
  layer: { name: string; map: string; gamemode: string; deprecated: boolean },
): MapVoteCandidate[] {
  if (candidates.some((c) => c.layer === layer.name)) return [...candidates];
  return [
    ...candidates,
    {
      layer: layer.name,
      map: layer.map,
      gamemode: layer.gamemode,
      weight: 1,
      enabled: true,
      deprecated: layer.deprecated,
    },
  ];
}

/** Removes the candidate at `index`. */
export function removeCandidateAt(
  candidates: readonly MapVoteCandidate[],
  index: number,
): MapVoteCandidate[] {
  return candidates.filter((_, i) => i !== index);
}
