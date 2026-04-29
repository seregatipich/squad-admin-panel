import { redirect } from 'next/navigation';

export default function LegacyRolesPage(): never {
  redirect('/settings/groups');
}
