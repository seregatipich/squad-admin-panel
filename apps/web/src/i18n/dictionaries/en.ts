import type { TranslationKey } from './ru';

/**
 * English dictionary. Typed as `Record<TranslationKey, string>` so it must
 * translate exactly the key set defined by the Russian source of truth — a
 * missing or misspelled key is a compile error.
 */
export const en: Record<TranslationKey, string> = {
  'app.title': 'Squad Admin Panel',
  'app.description': 'Open-source self-hosted admin panel for Squad dedicated servers',

  'nav.brand': 'Squad Admin Panel',
  'nav.group.servers': 'Servers',
  'nav.group.management': 'Management',
  'nav.group.audit': 'Audit',
  'nav.group.settings': 'Settings',
  'nav.dashboard': 'Dashboard',
  'nav.serversArchive': 'Archive',
  'nav.players': 'Players',
  'nav.suspects': 'Marks',
  'nav.leaderboards': 'Leaderboards',
  'nav.bonusLeaderboard': 'Bonuses',
  'nav.clans': 'Clans',
  'nav.matches': 'Matches',
  'nav.events': 'Events',
  'nav.combatLog': 'Combat log',
  'nav.votes': 'Votes',
  'nav.chat': 'Chat',
  'nav.notes': 'Notes',
  'nav.bannedNames': 'Banned names',
  'nav.externalBans': 'External bans',
  'nav.reports': 'Reports',
  'nav.issues': 'Tickets',
  'nav.vips': 'VIP',
  'nav.groups': 'Groups',
  'nav.users': 'Users',
  'nav.teamkills': 'Teamkills',
  'nav.audit': 'Action log',
  'nav.logs': 'Logs',
  'nav.account': 'Account',
  'nav.messageTemplates': 'Message templates',
  'nav.markTypes': 'Mark types',
  'nav.chatFlags': 'Chat flags',
  'nav.altDetection': 'Alt detection',
  'nav.alerts': 'Alerts',
  'nav.automation': 'Automation',
  'nav.seedNotifications': 'Seeding notifications',
  'nav.whitelist': 'Whitelist',
  'nav.economy': 'Economy',
  'nav.clanGuard': 'Clan-tag protection',
  'nav.tokens': 'API tokens',
  'nav.backup': 'Backups',
  'nav.banSources': 'Ban sources',
  'nav.discord': 'Discord',
  'nav.geoip': 'GeoIP (MaxMind)',
  'nav.logout': 'Log out',

  'login.heading': 'Squad Admin Panel',
  'login.error.authFailed': 'Could not verify your Steam sign-in. Please try again.',
  'login.error.notAuthorized':
    'Steam ID {steamId} does not have access to the panel. Contact an administrator.',
  'login.steamButton': 'Sign in with Steam',
  'login.steamOnly': 'Steam OpenID 2.0 is the only way to sign in.',

  'noAccess.heading': 'Access denied',
  'noAccess.withId': 'Steam ID {steamId} does not have a role in this panel.',
  'noAccess.withoutId': 'Your Steam account does not have a role in this panel.',
  'noAccess.noRole': 'You do not have access to the panel',
  'noAccess.roleNoAccess': 'Your role does not have access to the panel',
  'noAccess.noRoleHint':
    'Ask an administrator to assign you a role, then sign in again with Steam.',
  'noAccess.roleNoAccessHint': 'Ask an administrator to grant your role access to the panel.',
  'noAccess.steamIdLabel': 'Steam ID',
  'noAccess.instructions':
    'Contact an administrator to be assigned a role. Once assigned, sign in again with Steam.',
  'noAccess.backToLogin': 'Back to the sign-in page',
  'noAccess.ownerHint': 'If you are the Owner of a freshly installed panel, check the journal',

  'connection.unavailable': 'The panel is temporarily unavailable.',
  'connection.retry': 'Retry',
  'connection.dismiss': 'Dismiss',

  'localeSwitch.label': 'Language',
  'localeSwitch.en': 'English',
  'localeSwitch.ru': 'Русский',

  'errors.invalid_period': 'Invalid period.',
  'errors.rate_limited': 'Too many requests. Please try again later.',
  'errors.internal_error': 'Internal server error.',
  'errors.unknown': 'Something went wrong. Please try again.',
};
