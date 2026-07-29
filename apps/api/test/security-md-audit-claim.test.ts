import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const securityDocPath = resolve(__dirname, '../../../docs/architecture/security.md');
const ciWorkflowPath = resolve(__dirname, '../../../.github/workflows/ci.yml');

// The doc must never again claim CI enforces a `pnpm audit` gate that
// .github/workflows/ci.yml does not actually run (issue #253).
const PNPM_AUDIT_ENFORCED_IN_CI = /pnpm audit[^\n]*enforced in CI/;
const DEPENDABOT_REMEDIATION_CLAIM =
  'Dependabot alerts are tracked centrally (see #213) and worked down in remediation waves';

describe('docs/architecture/security.md — pnpm audit CI-gate claim', () => {
  const securityDoc = readFileSync(securityDocPath, 'utf-8');
  const ciWorkflow = readFileSync(ciWorkflowPath, 'utf-8');

  it('does not claim a pnpm audit step is enforced in CI', () => {
    expect(
      PNPM_AUDIT_ENFORCED_IN_CI.test(securityDoc),
      [
        'docs/architecture/security.md still asserts that `pnpm audit` is',
        '"enforced in CI", but .github/workflows/ci.yml has no such step.',
        'Correct the claim to describe the real Dependabot/remediation-wave',
        'process (see issue #253).',
      ].join('\n'),
    ).toBe(false);
  });

  it('the node CI job has no pnpm audit step (the fact the claim must match)', () => {
    expect(
      ciWorkflow.includes('pnpm audit'),
      [
        '.github/workflows/ci.yml now contains a `pnpm audit` step.',
        'docs/architecture/security.md was corrected on the assumption that no',
        'such CI gate exists — if one was added, update the doc to describe it',
        'instead of the Dependabot remediation-wave process.',
      ].join('\n'),
    ).toBe(false);
  });

  it('documents the real Dependabot remediation-wave process instead', () => {
    expect(
      securityDoc.includes(DEPENDABOT_REMEDIATION_CLAIM),
      [
        'docs/architecture/security.md is missing the corrected description of',
        'the dependency-vulnerability control that actually exists:',
        `  "${DEPENDABOT_REMEDIATION_CLAIM}"`,
        'See issue #253.',
      ].join('\n'),
    ).toBe(true);
  });
});
