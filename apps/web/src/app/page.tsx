import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function RootPage() {
  const jar = await cookies();
  const hasSession = jar.has('__Host-sid');
  if (hasSession) redirect('/dashboard');
  redirect('/login');
}
