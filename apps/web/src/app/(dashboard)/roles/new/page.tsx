import { redirect } from 'next/navigation';

export default function LegacyRoleCreatePage(): never {
  redirect('/settings/groups');
}
