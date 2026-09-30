/**
 * Response body of `GET /api/v1/vote-analytics`: the API builds it and the
 * dashboard panel reads it, so both sides share this one declaration.
 */
export interface VoteAnalytics {
  server_id: string | null;
  from: string;
  to: string;
  summary: {
    total_votes: number;
    passed: number;
    failed: number;
    cancelled: number;
    pass_rate: number;
  };
  pass_rate_by_server: Array<{
    server_id: string;
    server_name: string | null;
    total: number;
    passed: number;
    pass_rate: number;
  }>;
  pass_rate_by_map: Array<{ map: string; total: number; passed: number; pass_rate: number }>;
  trend: Array<{ day: string; count: number }>;
  top_initiators: Array<{
    player_id: string;
    nickname: string | null;
    initiated: number;
    passed: number;
    success_ratio: number;
  }>;
  by_hour: Array<{ hour: number; count: number }>;
  serial_skippers: Array<{ player_id: string; nickname: string | null; skip_count: number }>;
  /** Trailing window the skipper threshold applies to; absent on older API builds. */
  serial_skipper_window_days?: number;
}
