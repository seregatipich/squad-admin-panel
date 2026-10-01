import type { ReportListItem } from '@/lib/live-bus';

export interface ReportListResponse {
  items: ReportListItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface LinkedModerationAction {
  id: string;
  action_type: string;
  reason: string | null;
  context: Record<string, unknown>;
  report_id: string | null;
  created_at: string | null;
  reverted_at: string | null;
  server: { id: string; name: string | null } | null;
  author:
    | { kind: 'player'; id: string; name: string | null }
    | { kind: 'system'; label: string | null };
}

export interface BanAltWarningItem {
  player_id: string;
  name: string;
  link_type?: string;
  status?: string;
  confidence?: 'high';
  online: boolean;
  has_active_ban: boolean;
}

export interface BanAltWarning {
  can_view_ips: boolean;
  confirmed_count: number;
  candidate_count: number;
  confirmed: BanAltWarningItem[];
  candidates: BanAltWarningItem[];
}
