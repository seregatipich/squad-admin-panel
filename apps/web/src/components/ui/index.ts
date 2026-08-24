/**
 * Примитивы дизайн-системы панели.
 *
 * Правила, которые они реализуют, описаны в
 * `docs/components/web/design-system.md`; токены — в `src/styles/globals.css`.
 * Страница собирается из этих компонентов, а не из строк utility-классов:
 * так высота кнопки, ширина содержимого и поведение диалога задаются в одном
 * месте, а не на семидесяти девяти страницах по отдельности.
 *
 * Примитивы не читают словарь переводов — весь человекочитаемый текст,
 * включая `aria-label`, приходит пропсами.
 */

export type { AlertDialogChallenge, AlertDialogProps, AlertDialogTone } from './AlertDialog';
export { AlertDialog } from './AlertDialog';
export type { BadgeProps, BadgeSize, BadgeTone } from './Badge';
export { Badge } from './Badge';
export type {
  ButtonLinkProps,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  IconButtonProps,
  IconButtonSize,
} from './Button';
export { Button, ButtonLink, IconButton } from './Button';
export type { CardPadding } from './Card';
export { Card, CardBody, CardFooter, CardGrid, CardHeader } from './Card';
export type { DateTimeMode, DateTimeProps, RelativeLabels } from './DateTime';
export { DateTime, formatAbsolute, formatClock, formatRelative } from './DateTime';
export type { EmptyStateVariant } from './EmptyState';
export { EmptyState } from './EmptyState';
export type {
  CheckboxProps,
  FieldSize,
  SelectProps,
  SwitchProps,
  TextareaProps,
  TextInputProps,
} from './Field';
export { Checkbox, FieldRow, Select, Switch, Textarea, TextInput } from './Field';
export type { GroupedRowProps } from './GroupedList';
export { GroupedList, GroupedRow } from './GroupedList';
export type { InlineBannerTone } from './InlineBanner';
export { InlineBanner } from './InlineBanner';
export * from './icons';
export type { MenuActionItem, MenuItem, MenuLinkItem, MenuTrigger } from './Menu';
export { Menu } from './Menu';
export type { ModalProps, ModalSize } from './Modal';
export { Modal } from './Modal';
export type { PageWidth } from './PageContainer';
export { PageContainer } from './PageContainer';
export type { Breadcrumb, PageHeaderProps } from './PageHeader';
export { PageHeader } from './PageHeader';
export type { PaginationLabels, PaginationProps } from './Pagination';
export { Pagination } from './Pagination';
export type { SearchFieldProps } from './SearchField';
export { SearchField } from './SearchField';
export type { SegmentedControlItem } from './SegmentedControl';
export { SegmentedControl } from './SegmentedControl';
export type { SegmentedNavItem } from './SegmentedNav';
export { isSegmentActive, SegmentedNav } from './SegmentedNav';
export type { SkeletonVariant } from './Skeleton';
export { Skeleton, SkeletonTable } from './Skeleton';
export type {
  StatTileProgress,
  StatTileProps,
  StatTileSegment,
  StatTileSize,
  StatTileTone,
} from './StatTile';
export { StatTile } from './StatTile';
export type { StatusBadgeProps, StatusDotProps, StatusState } from './StatusBadge';
export { StatusBadge, StatusDot } from './StatusBadge';
export type { SortDirection, TableAlign, TableRowTone } from './Table';
export {
  SortableTh,
  Table,
  TableBody,
  TableCaption,
  TableHead,
  TableRow,
  Td,
  Th,
} from './Table';
export { ToastRegion } from './ToastRegion';
export type { ToolbarProps } from './Toolbar';
export { Toolbar } from './Toolbar';
