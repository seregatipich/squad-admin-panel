export interface PlayerVoteStats {
  player_id: string;
  initiated: number;
  participated: number;
  serial_skipper: {
    flagged: boolean;
    skip_count: number;
    threshold: number;
    window_days: number;
  };
}

export function serialSkipperLabel(skipper: PlayerVoteStats['serial_skipper']): string {
  return `${skipper.skip_count} скипов за ${skipper.window_days} дн. (порог ${skipper.threshold})`;
}
