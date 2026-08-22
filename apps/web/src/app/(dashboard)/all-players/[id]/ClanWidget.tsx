import { ButtonLink } from '@/components/ui';

export interface PlayerClan {
  id: string;
  name: string;
  tags: string[];
  member_role: string;
}

const CLAN_ROLE_LABELS: Record<string, string> = {
  leader: 'Глава',
  deputy: 'Зам',
  member: 'Участник',
};

/** Clan widget for the player header (PLAYER-4): links to the clan, hidden when the player isn't a member. */
export function ClanWidget({ clan }: { clan: PlayerClan | null }) {
  if (!clan) return null;
  return (
    <ButtonLink href={`/clans/${clan.id}`} variant="secondary" size="sm">
      <span>{clan.name}</span>
      <span className="text-ink-3">{CLAN_ROLE_LABELS[clan.member_role] ?? clan.member_role}</span>
    </ButtonLink>
  );
}
