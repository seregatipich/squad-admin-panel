import Link from 'next/link';

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
    <Link
      href={`/clans/${clan.id}`}
      className="flex items-center gap-1.5 rounded bg-neutral-800 px-2 py-1 text-xs text-sky-400 hover:bg-neutral-700"
    >
      <span>{clan.name}</span>
      <span className="text-neutral-400">
        {CLAN_ROLE_LABELS[clan.member_role] ?? clan.member_role}
      </span>
    </Link>
  );
}
