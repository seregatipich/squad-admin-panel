// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForceStopDialog } from './ForceStopDialog';

const SERVER = 'RU #1';

afterEach(cleanup);

function confirmButton() {
  return within(screen.getByRole('dialog')).getByRole('button', {
    name: 'Остановить принудительно',
  });
}

function typeServerName(value: string) {
  fireEvent.change(screen.getByLabelText(/имя сервера/i), { target: { value } });
}

describe('ForceStopDialog', () => {
  it('exports a React component function', async () => {
    const mod = await import('./ForceStopDialog');
    expect(typeof mod.ForceStopDialog).toBe('function');
  });

  it('renders nothing while closed', () => {
    render(
      <ForceStopDialog
        open={false}
        onOpenChange={vi.fn()}
        serverName={SERVER}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the server and warns that the stop cannot be undone', () => {
    render(<ForceStopDialog open onOpenChange={vi.fn()} serverName={SERVER} onConfirm={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Принудительная остановка')).toBeInTheDocument();
    expect(within(dialog).getAllByText(SERVER).length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Это действие нельзя отменить.')).toBeInTheDocument();
  });

  it('keeps the confirm button disabled until the server name is typed exactly', () => {
    render(<ForceStopDialog open onOpenChange={vi.fn()} serverName={SERVER} onConfirm={vi.fn()} />);
    expect(confirmButton()).toBeDisabled();
    typeServerName('RU');
    expect(confirmButton()).toBeDisabled();
    typeServerName(SERVER);
    expect(confirmButton()).toBeEnabled();
  });

  it('runs the confirm handler and then closes', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <ForceStopDialog
        open
        onOpenChange={onOpenChange}
        serverName={SERVER}
        onConfirm={onConfirm}
      />,
    );
    typeServerName(SERVER);
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open when the confirm handler rejects', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('bridge down'));
    const onOpenChange = vi.fn();
    render(
      <ForceStopDialog
        open
        onOpenChange={onOpenChange}
        serverName={SERVER}
        onConfirm={onConfirm}
      />,
    );
    typeServerName(SERVER);
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('asks to close on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <ForceStopDialog open onOpenChange={onOpenChange} serverName={SERVER} onConfirm={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('asks to close via the Отмена button', () => {
    const onOpenChange = vi.fn();
    render(
      <ForceStopDialog open onOpenChange={onOpenChange} serverName={SERVER} onConfirm={vi.fn()} />,
    );
    const buttons = within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Отмена' });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
