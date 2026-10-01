'use client';

import { useState } from 'react';
import { Button, Modal, Select } from '@/components/ui';
import type { RoleOption } from './members-shared';

export function MoveModal({
  count,
  roles,
  onClose,
  onMove,
}: {
  count: number;
  roles: RoleOption[];
  onClose: () => void;
  onMove: (targetRoleId: string) => void | Promise<void>;
}) {
  const [target, setTarget] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title={`Переместить в роль (${count})`}
      size="sm"
      closeLabel="Закрыть"
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button
            variant="primary"
            onClick={() => target && void onMove(target)}
            disabled={target === ''}
          >
            Переместить
          </Button>
        </>
      }
    >
      <div data-testid="move-modal">
        <Select
          aria-label="Целевая роль"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">— выберите роль —</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>
    </Modal>
  );
}
