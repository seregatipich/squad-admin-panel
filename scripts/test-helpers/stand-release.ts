/**
 * Release identifiers shared by the stand host tests (deploy, rollback and the
 * forced-command entry) so the three files describe the same release.
 */
export const IMAGE_REPO = 'ghcr.io/seregatipich/squad-panel';
export const RELEASE_SHA = 'a'.repeat(40);

export function imageRef(name: string, fill: string): string {
  return `${IMAGE_REPO}-${name}@sha256:${fill.repeat(64)}`;
}
