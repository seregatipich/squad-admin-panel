'use client';
import { useRouter } from 'next/navigation';
import { RoleEditor } from '@/components/RoleEditor';

export default function NewRolePage() {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Новая роль</h1>
      <RoleEditor
        submitLabel="Создать"
        onCancel={() => router.push('/roles')}
        onSubmit={async (data) => {
          const r = await fetch('/api/v1/roles', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data),
          });
          if (!r.ok) {
            if (r.status === 409) throw new Error('Роль с таким именем уже существует');
            throw new Error(`HTTP ${r.status}`);
          }
          router.push('/roles');
        }}
      />
    </div>
  );
}
