import type { PermissionProfile, PermissionProfileId } from '@jarvis/types';
import { RiskLevel } from '@jarvis/types';

/**
 * Locked: nothing changes the machine without a prompt; irreversible work is refused.
 * Balanced: reads and reversible in-scope writes flow, everything else is confirmed.
 * (An `Open` profile exists in the spec but is intentionally not shipped in this milestone.)
 */
export const PERMISSION_PROFILES: Record<PermissionProfileId, PermissionProfile> = {
  locked: {
    id: 'locked',
    name: 'Locked',
    description: 'Ask before any change. Refuse irreversible and system-level actions.',
    effects: {
      [RiskLevel.Safe]: 'allow',
      [RiskLevel.Low]: 'ask',
      [RiskLevel.Medium]: 'ask',
      [RiskLevel.High]: 'deny',
      [RiskLevel.Critical]: 'deny',
    },
    requireConfirmationPhraseAtOrAbove: RiskLevel.High,
  },
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    description: 'Reads and reversible writes inside allowed folders run freely; the rest is confirmed.',
    effects: {
      [RiskLevel.Safe]: 'allow',
      [RiskLevel.Low]: 'allow',
      [RiskLevel.Medium]: 'ask',
      [RiskLevel.High]: 'ask',
      [RiskLevel.Critical]: 'deny',
    },
    requireConfirmationPhraseAtOrAbove: RiskLevel.High,
  },
};

export const DEFAULT_PROFILE: PermissionProfileId = 'balanced';
