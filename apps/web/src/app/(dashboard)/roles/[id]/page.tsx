'use client';
import type { RoleColor } from '@squad/shared-config/role-colors';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { RoleEditor } from '@/components/RoleEditor';

interface RoleRow {
  id: string;
  name: string;
  color: RoleColor;
  description: string | null;
  is_system_role: boolean;
  permissions: string[];
}

export default function EditRolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [role, setRole] = useState<RoleRow | null>(null);

  useEffect(() => {
    fetch(`/api/v1/roles/${id}`, { credentials: 'include' })
      .then((r) => r.json())
      .then(setRole);
  }, [id]);

  if (!role) return <div className="text-neutral-500">Загрузка…</div>;
  const isOwner = role.is_system_role && role.name === 'Owner';

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{role.name}</h1>
      <RoleEditor
        initial={{
          name: role.name,
          color: role.color,
          description: role.description,
          permissions: role.permissions,
          isSystemRole: role.is_system_role,
          isOwner,
        }}
        submitLabel="Сохранить"
        onCancel={() => router.push('/roles')}
        onSubmit={async (data) => {
          const r = await fetch(`/api/v1/roles/${id}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data),
          });
          if (!r.ok) {
            if (r.status === 409) throw new Error('Имя занято');
            if (r.status === 400) throw new Error('Owner не редактируется');
            throw new Error(`HTTP ${r.status}`);
          }
          router.push('/roles');
        }}
      />
    </div>
  );
}
