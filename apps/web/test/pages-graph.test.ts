import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => true }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() })),
  usePathname: vi.fn(() => '/dashboard'),
  useSearchParams: vi.fn(() => ({ get: vi.fn(() => null) })),
  useParams: vi.fn(() => ({})),
}));
vi.mock('next/dynamic', () => ({
  default: vi.fn(() => () => null),
}));
vi.mock('next/link', () => ({
  default: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/lib/dal', () => ({
  requireSession: vi.fn().mockResolvedValue({
    player_id: '00000000-0000-0000-0000-000000000001',
    steam_id64: '1',
    canonical_name: 'Test',
    permissions: [],
  }),
  getSession: vi.fn().mockResolvedValue({
    player_id: '00000000-0000-0000-0000-000000000001',
    steam_id64: '1',
    canonical_name: 'Test',
    permissions: [],
  }),
  SESSION_COOKIE: '__Host-sid',
}));
vi.mock('../src/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue({}) }));
vi.mock('@squad/shared-config/role-colors', () => ({
  ROLE_COLORS: [],
  ROLE_COLOR_HEX: {},
}));
vi.mock('@squad/shared-config', () => ({
  SQUAD_PERMISSIONS: [],
  PERMISSION_KEYS: [],
}));
vi.mock('../src/components/LiveIndicator', () => ({
  LiveIndicator: () => null,
}));
vi.mock('../src/components/LogConsole', () => ({
  LogConsole: () => null,
}));
vi.mock('../src/components/LogList', () => ({
  LogList: () => null,
}));
vi.mock('../src/components/AdminsCfgDriftBanner', () => ({
  AdminsCfgDriftBanner: () => null,
}));
vi.mock('../src/components/RoleColorDot', () => ({
  RoleColorDot: () => null,
}));
vi.mock('../src/components/RoleEditor', () => ({
  RoleEditor: () => null,
}));
vi.mock('../src/lib/use-live-bus', () => ({
  useLiveSubscription: vi.fn(),
  useLiveBusState: vi.fn(() => 'closed'),
  useBridgeState: vi.fn(() => 'unknown'),
}));
vi.mock('../src/lib/live-bus', () => ({
  getLiveBus: vi.fn(() => ({
    subscribe: vi.fn(),
    state: vi.fn(() => 'closed'),
  })),
}));

import auditPage from '../src/app/(dashboard)/audit/page';
import dashboardPage from '../src/app/(dashboard)/dashboard/page';
import logsPage from '../src/app/(dashboard)/logs/page';
import playerDetailPage from '../src/app/(dashboard)/players/[id]/page';
import playersPage from '../src/app/(dashboard)/players/page';
import rolesEditPage from '../src/app/(dashboard)/roles/[id]/page';
import rolesNewPage from '../src/app/(dashboard)/roles/new/page';
import rolesPage from '../src/app/(dashboard)/roles/page';
import serverConfigsPage from '../src/app/(dashboard)/servers/[id]/configs/page';
import serverEventsPage from '../src/app/(dashboard)/servers/[id]/events/page';
import serverDetailPage from '../src/app/(dashboard)/servers/[id]/page';
import serversArchiveDetailPage from '../src/app/(dashboard)/servers/archive/[id]/page';
import serversArchiveRestorePage from '../src/app/(dashboard)/servers/archive/[id]/restore/page';
import serversArchivePage from '../src/app/(dashboard)/servers/archive/page';
import serversNewPage from '../src/app/(dashboard)/servers/new/page';
import serversPage from '../src/app/(dashboard)/servers/page';
import settingsAccountPage from '../src/app/(dashboard)/settings/account/page';
import settingsGroupMembersPage from '../src/app/(dashboard)/settings/groups/[id]/members/page';
import settingsGroupsPage from '../src/app/(dashboard)/settings/groups/page';
import settingsTokensPage from '../src/app/(dashboard)/settings/tokens/page';
import usersPage from '../src/app/(dashboard)/users/page';
import publicUploadPage from '../src/app/(public)/upload/[token]/page';
import loginPage from '../src/app/login/page';
import noAccessPage from '../src/app/no-access/page';
import rootPage from '../src/app/page';

describe('pages static import graph', () => {
  it('root page exports default', () => {
    expect(rootPage).toBeDefined();
  });

  it('login page exports default', () => {
    expect(loginPage).toBeDefined();
  });

  it('no-access page exports default', () => {
    expect(noAccessPage).toBeDefined();
  });

  it('dashboard page exports default', () => {
    expect(dashboardPage).toBeDefined();
  });

  it('audit page exports default', () => {
    expect(auditPage).toBeDefined();
  });

  it('logs page exports default', () => {
    expect(logsPage).toBeDefined();
  });

  it('players page exports default', () => {
    expect(playersPage).toBeDefined();
  });

  it('player detail page exports default', () => {
    expect(playerDetailPage).toBeDefined();
  });

  it('roles page exports default', () => {
    expect(rolesPage).toBeDefined();
  });

  it('roles new page exports default', () => {
    expect(rolesNewPage).toBeDefined();
  });

  it('roles edit page exports default', () => {
    expect(rolesEditPage).toBeDefined();
  });

  it('servers page exports default', () => {
    expect(serversPage).toBeDefined();
  });

  it('servers new page exports default', () => {
    expect(serversNewPage).toBeDefined();
  });

  it('server detail page exports default', () => {
    expect(serverDetailPage).toBeDefined();
  });

  it('server configs page exports default', () => {
    expect(serverConfigsPage).toBeDefined();
  });

  it('server events page exports default', () => {
    expect(serverEventsPage).toBeDefined();
  });

  it('servers archive page exports default', () => {
    expect(serversArchivePage).toBeDefined();
  });

  it('servers archive detail page exports default', () => {
    expect(serversArchiveDetailPage).toBeDefined();
  });

  it('servers archive restore page exports default', () => {
    expect(serversArchiveRestorePage).toBeDefined();
  });

  it('settings account page exports default', () => {
    expect(settingsAccountPage).toBeDefined();
  });

  it('settings tokens page exports default', () => {
    expect(settingsTokensPage).toBeDefined();
  });

  it('settings groups page exports default', () => {
    expect(settingsGroupsPage).toBeDefined();
  });

  it('settings group members page exports default', () => {
    expect(settingsGroupMembersPage).toBeDefined();
  });

  it('users page exports default', () => {
    expect(usersPage).toBeDefined();
  });

  it('public one-time upload page exports default', () => {
    expect(publicUploadPage).toBeDefined();
  });
});
