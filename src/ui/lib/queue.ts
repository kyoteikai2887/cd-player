import type { PlayerSnapshot } from '../../contracts/player.ts';

/**
 * The queue played to its end and stopped: paused at the end of the last entry with repeat off
 * (the core's `advance` leaves it there). Play then starts the queue again from the top.
 */
export function queueEnded(player: PlayerSnapshot): boolean {
  if (player.status !== 'paused' || player.repeat !== 'off' || !player.queue.length) return false;
  if (player.currentQueueIndex < 0 || player.currentQueueIndex < player.queue.length - 1) return false;
  return player.durationMs > 0 && player.positionMs >= player.durationMs - 250;
}
