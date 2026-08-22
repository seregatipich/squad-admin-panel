'use client';

import { Badge } from '@/components/ui';

interface Props {
  crashLoop: boolean;
  crashCount: number;
}

/**
 * Метка аварий сервера.
 *
 * Пульсации у цикла аварий больше нет: по §9 движение зарезервировано за
 * индикатором «данные идут прямо сейчас», и мигающая метка в списке серверов
 * лишь отвлекала оператора, который смотрит в этот экран всю смену. Разницу
 * между циклом и разовыми авариями несут слова и тон метки.
 */
export function CrashBadge({ crashLoop, crashCount }: Props) {
  if (crashCount === 0 && !crashLoop) return null;

  if (crashLoop) {
    return <Badge tone="crit">Цикл аварий</Badge>;
  }

  return (
    <Badge tone="warn">
      {crashCount} {crashCount === 1 ? 'авария' : 'аварий'}
    </Badge>
  );
}
