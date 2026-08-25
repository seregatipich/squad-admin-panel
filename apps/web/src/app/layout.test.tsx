import { describe, expect, it } from 'vitest';
import RootLayout, { generateMetadata } from './layout';

describe('RootLayout', () => {
  it('is a valid React component', () => {
    expect(RootLayout).toBeDefined();
    expect(typeof RootLayout).toBe('function');
  });

  it('renders <html lang="ru">', () => {
    const element = RootLayout({ children: null });
    expect(element.props.lang).toBe('ru');
  });
});

describe('generateMetadata', () => {
  it('returns the Russian title and description', () => {
    const meta = generateMetadata();
    expect(meta.title).toBe('Squad Admin Panel');
    expect(meta.description).toBe(
      'Опенсорсная self-hosted админ-панель для выделенных серверов Squad',
    );
  });
});
