// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import SettingsLayout from './layout';

afterEach(cleanup);

describe('SettingsLayout', () => {
  it('gives the whole section the reading width the design system assigns to settings', () => {
    // §3: настройки — `reading`. Раздел раньше стоял на `wide`, и строка
    // «подпись … значение» растягивалась через весь монитор.
    const { container } = render(<SettingsLayout>{<p>содержимое</p>}</SettingsLayout>);
    const shell = container.firstElementChild;
    expect(shell).toHaveClass('max-w-3xl');
    expect(shell).toHaveClass('mx-auto');
    expect(shell?.className).not.toContain('max-w-6xl');
    expect(shell?.className).not.toContain('max-w-[1600px]');
  });

  it('renders the page inside that width rather than beside it', () => {
    const { container, getByText } = render(<SettingsLayout>{<p>содержимое</p>}</SettingsLayout>);
    expect(container.firstElementChild).toContainElement(getByText('содержимое'));
  });
});
