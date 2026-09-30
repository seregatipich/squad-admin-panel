// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function DiffStub() {
      return <div data-testid="diff-stub" />;
    },
}));

import { type DriftItem, DriftPanel } from './DriftPanel';
import { type FileItem, FileList } from './FileList';

const drifted: DriftItem = {
  name: 'Server.cfg',
  state: 'drift',
  disk_sha256: 'a',
  version_sha256: 'b',
  tip_version_id: 'v1',
};

const files: FileItem[] = [
  { name: 'Server.cfg', size: 1, sha256: 'a', behavior: 'hot_reload', exists: true },
  { name: 'Rcon.cfg', size: 1, sha256: 'b', behavior: 'requires_restart', exists: true },
];

afterEach(cleanup);

describe('DriftPanel', () => {
  it('renders nothing without drifted files', () => {
    const { container } = render(
      <DriftPanel
        items={[]}
        diff={null}
        busy={false}
        onOpenDiff={vi.fn()}
        onCloseDiff={vi.fn()}
        onResolve={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('reports the file and chosen resolution, and blocks resolving while busy', () => {
    const onResolve = vi.fn();
    const onOpenDiff = vi.fn();
    const { rerender } = render(
      <DriftPanel
        items={[drifted]}
        diff={{ name: 'Server.cfg', tip: 'x', disk: 'y' }}
        busy={false}
        onOpenDiff={onOpenDiff}
        onCloseDiff={vi.fn()}
        onResolve={onResolve}
      />,
    );
    fireEvent.click(screen.getByText('Принять'));
    fireEvent.click(screen.getByText('Откатить'));
    fireEvent.click(screen.getByText('Diff'));
    expect(onResolve).toHaveBeenNthCalledWith(1, 'Server.cfg', 'accept');
    expect(onResolve).toHaveBeenNthCalledWith(2, 'Server.cfg', 'revert');
    expect(onOpenDiff).toHaveBeenCalledWith(drifted);
    expect(screen.getByTestId('config-drift-diff')).toBeTruthy();

    rerender(
      <DriftPanel
        items={[drifted]}
        diff={null}
        busy
        onOpenDiff={onOpenDiff}
        onCloseDiff={vi.fn()}
        onResolve={onResolve}
      />,
    );
    expect((screen.getByText('Принять') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('config-drift-diff')).toBeNull();
  });
});

describe('FileList', () => {
  it('marks drifted files and reports the clicked file', () => {
    const onSelect = vi.fn();
    render(
      <FileList files={files} selected="Rcon.cfg" driftItems={[drifted]} onSelect={onSelect} />,
    );
    expect(screen.getAllByTestId('file-drift-marker')).toHaveLength(1);
    fireEvent.click(screen.getByText('Server.cfg'));
    expect(onSelect).toHaveBeenCalledWith('Server.cfg');
    expect(screen.getByText('Rcon.cfg').closest('button')?.getAttribute('aria-current')).toBe(
      'true',
    );
  });
});
