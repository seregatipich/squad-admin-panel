import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/dashboard'),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
}));
vi.mock('next/link', () => ({
  default: ({ children }: { children: unknown }) => children,
}));
vi.mock('next/dynamic', () => ({
  default: vi.fn(() => () => null),
}));
vi.mock('@squad/shared-config/role-colors', () => ({
  ROLE_COLORS: ['red', 'blue'],
  ROLE_COLOR_HEX: { red: '#f00', blue: '#00f' },
  isRoleColorHex: vi.fn(() => false),
  isRoleColorPaletteName: vi.fn(() => true),
}));
vi.mock('../src/lib/live-bus', () => ({
  getLiveBus: vi.fn(() => ({
    subscribe: vi.fn(() => vi.fn()),
    state: vi.fn(() => 'closed'),
  })),
}));
vi.mock('../src/lib/use-live-bus', () => ({
  useLiveSubscription: vi.fn(),
  useLiveBusState: vi.fn(() => 'closed'),
  useBridgeState: vi.fn(() => 'unknown'),
}));
vi.mock('recharts', () => ({
  ResponsiveContainer: () => null,
  AreaChart: () => null,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));

import { AdminsCfgDriftBanner } from '../src/components/AdminsCfgDriftBanner';
import { ConnectionBanner } from '../src/components/connection-banner';
import { DiskBreakdownModal } from '../src/components/DiskBreakdownModal';
import { DockerPruneButton } from '../src/components/DockerPruneButton';
import { LogConsole } from '../src/components/LogConsole';
import { LogList } from '../src/components/LogList';
import { LogoutButton } from '../src/components/LogoutButton';
import MetricHistoryChart from '../src/components/MetricHistoryChart';
import { MetricHistoryModal } from '../src/components/MetricHistoryModal';
import { RestartBridgeButton } from '../src/components/RestartBridgeButton';
import { RoleColorDot } from '../src/components/RoleColorDot';
import { RoleEditor } from '../src/components/RoleEditor';
import { ServerBar } from '../src/components/ServerBar';
import { TopNav } from '../src/components/TopNav';

describe('components static import graph', () => {
  it('AdminsCfgDriftBanner is a function', () => {
    expect(typeof AdminsCfgDriftBanner).toBe('function');
  });

  it('ConnectionBanner is a function', () => {
    expect(typeof ConnectionBanner).toBe('function');
  });

  it('DiskBreakdownModal is a function', () => {
    expect(typeof DiskBreakdownModal).toBe('function');
  });

  it('DockerPruneButton is a function', () => {
    expect(typeof DockerPruneButton).toBe('function');
  });

  it('LogConsole is a function', () => {
    expect(typeof LogConsole).toBe('function');
  });

  it('LogList is a function', () => {
    expect(typeof LogList).toBe('function');
  });

  it('LogoutButton is a function', () => {
    expect(typeof LogoutButton).toBe('function');
  });

  it('MetricHistoryChart is a function', () => {
    expect(typeof MetricHistoryChart).toBe('function');
  });

  it('MetricHistoryModal is a function', () => {
    expect(typeof MetricHistoryModal).toBe('function');
  });

  it('RestartBridgeButton is a function', () => {
    expect(typeof RestartBridgeButton).toBe('function');
  });

  it('RoleColorDot is a function', () => {
    expect(typeof RoleColorDot).toBe('function');
  });

  it('RoleEditor is a function', () => {
    expect(typeof RoleEditor).toBe('function');
  });

  it('TopNav is a function', () => {
    expect(typeof TopNav).toBe('function');
  });

  it('ServerBar is a function', () => {
    expect(typeof ServerBar).toBe('function');
  });
});
