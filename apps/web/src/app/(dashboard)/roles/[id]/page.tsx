import { redirect } from 'next/navigation';

export default function LegacyRoleEditPage(): never {
  redirect('/settings/groups');
}
