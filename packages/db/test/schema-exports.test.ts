import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as auditLogSchema from '../src/schema/audit-log.js';
import * as configVersionsSchema from '../src/schema/config-versions.js';
import * as diagnosticEventsSchema from '../src/schema/diagnostic-events.js';
import * as eventsSchema from '../src/schema/events.js';
import * as issueCommentsSchema from '../src/schema/issue-comments.js';
import * as issueLabelLinksSchema from '../src/schema/issue-label-links.js';
import * as issueLabelsSchema from '../src/schema/issue-labels.js';
import * as issuesSchema from '../src/schema/issues.js';
import * as panelMetaSchema from '../src/schema/panel-meta.js';
import * as playerApiTokensSchema from '../src/schema/player-api-tokens.js';
import * as playerIpHistorySchema from '../src/schema/player-ip-history.js';
import * as playerNameHistorySchema from '../src/schema/player-name-history.js';
import * as playersSchema from '../src/schema/players.js';
import * as rolePermissionsSchema from '../src/schema/role-permissions.js';
import * as roleSquadPermissionsSchema from '../src/schema/role-squad-permissions.js';
import * as rolesSchema from '../src/schema/roles.js';
import * as serverCredentialsSchema from '../src/schema/server-credentials.js';
import * as serverSettingsSchema from '../src/schema/server-settings.js';
import * as serversSchema from '../src/schema/servers.js';
import * as sessionsSchema from '../src/schema/sessions.js';

describe('individual schema module exports', () => {
  const modules = [
    { mod: auditLogSchema, name: 'audit-log' },
    { mod: configVersionsSchema, name: 'config-versions' },
    { mod: diagnosticEventsSchema, name: 'diagnostic-events' },
    { mod: eventsSchema, name: 'events' },
    { mod: issueCommentsSchema, name: 'issue-comments' },
    { mod: issueLabelLinksSchema, name: 'issue-label-links' },
    { mod: issueLabelsSchema, name: 'issue-labels' },
    { mod: issuesSchema, name: 'issues' },
    { mod: panelMetaSchema, name: 'panel-meta' },
    { mod: playerApiTokensSchema, name: 'player-api-tokens' },
    { mod: playerIpHistorySchema, name: 'player-ip-history' },
    { mod: playerNameHistorySchema, name: 'player-name-history' },
    { mod: playersSchema, name: 'players' },
    { mod: rolePermissionsSchema, name: 'role-permissions' },
    { mod: roleSquadPermissionsSchema, name: 'role-squad-permissions' },
    { mod: rolesSchema, name: 'roles' },
    { mod: serverCredentialsSchema, name: 'server-credentials' },
    { mod: serverSettingsSchema, name: 'server-settings' },
    { mod: serversSchema, name: 'servers' },
    { mod: sessionsSchema, name: 'sessions' },
  ];

  for (const { mod, name } of modules) {
    it(`${name} exports at least one table with columns`, () => {
      const tables = Object.values(mod).filter(
        (v) => v && typeof v === 'object' && typeof getTableName(v as never) === 'string',
      );
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        const cols = getTableColumns(table as never);
        expect(Object.keys(cols).length).toBeGreaterThan(0);
      }
    });
  }
});
