/**
 * Chipotle Rewards — points and tier logic.
 * Members earn 10 points per dollar spent (on the order total).
 */
export function earnedPoints(total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.floor(total * 10);
}

export type RewardTier = 'Member' | 'Silver' | 'Gold' | 'Platinum';

export function rewardTier(points: number): RewardTier {
  if (points >= 2000) {
    return 'Platinum';
  }
  if (points >= 1000) {
    return 'Gold';
  }
  if (points >= 250) {
    return 'Silver';
  }
  return 'Member';
}

/**
 * A free entree can be redeemed at 1,250 points.
 */
export const FREE_ENTREE_COST = 1250;

export function canRedeemFreeEntree(points: number): boolean {
  return points >= FREE_ENTREE_COST;
}

/**
 * Points remaining until the next free entree (0 once eligible).
 */
export function pointsToNextReward(points: number): number {
  if (points >= FREE_ENTREE_COST) {
    return 0;
  }
  return FREE_ENTREE_COST - points;
}
