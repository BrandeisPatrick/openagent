// Permission modes: labels, descriptions, icons and chip tints (see PermissionMode in shared/types.ts).

import type { AppConfig, PermissionMode } from '../shared/types';
import type { IconName } from './icons.js';

export type ModeTone = 'neutral' | 'accent' | 'success' | 'danger';

export interface ModeInfo {
  label: string;
  /** One line under the label in the mode menu, also the chip's tooltip */
  desc: string;
  /** Second sentence of the "Permission mode: …" notice */
  hint: string;
  icon: IconName;
  tone: ModeTone;
  /** Class on #mode-btn ('' for the plain chip) */
  chipClass: string;
}

export const MODES: Record<PermissionMode, ModeInfo> = {
  ask: {
    label: 'Ask before actions',
    desc: 'Approve commands, writes and edits',
    hint: 'Commands, writes and edits show an approval card',
    icon: 'shield-check',
    tone: 'neutral',
    chipClass: '',
  },
  acceptEdits: {
    label: 'Accept edits',
    desc: 'Edits run; commands still ask',
    hint: 'Writes and edits in the working directory run without asking; commands still ask',
    icon: 'file-check',
    tone: 'neutral',
    chipClass: 'accept-edits',
  },
  auto: {
    label: 'Auto',
    desc: 'Runs on its own; risky actions still ask',
    hint: 'OpenAgent works on its own and pauses only for risky actions',
    icon: 'zap',
    tone: 'accent',
    chipClass: 'auto',
  },
  plan: {
    label: 'Plan',
    desc: 'Read-only; propose a plan to approve',
    hint: 'OpenAgent explores read-only and proposes a plan for you to approve',
    icon: 'clipboard',
    tone: 'success',
    chipClass: 'plan',
  },
  bypass: {
    label: 'Bypass permissions',
    desc: 'Runs everything without asking',
    hint: 'Everything runs without asking, including risky actions',
    icon: 'shield-off',
    tone: 'danger',
    chipClass: 'bypass',
  },
};

/** ⇧Tab cycles these; Bypass is only reachable from the menu. */
export const MODE_CYCLE: PermissionMode[] = ['ask', 'acceptEdits', 'auto', 'plan'];
export const MODE_CHIP_CLASSES = Object.values(MODES)
  .map((m) => m.chipClass)
  .filter(Boolean);

export function isMode(m: unknown): m is PermissionMode {
  return typeof m === 'string' && Object.prototype.hasOwnProperty.call(MODES, m);
}

/** The config's mode; unknown strings (e.g. the retired "readonly") fall back to ask. */
export function modeOf(config: Pick<AppConfig, 'permissionMode' | 'autoApprove'> | undefined): PermissionMode {
  if (!config) return 'ask';
  if (isMode(config.permissionMode)) return config.permissionMode;
  if (config.permissionMode === undefined || config.permissionMode === null) return config.autoApprove ? 'bypass' : 'ask';
  return 'ask';
}

export function nextMode(mode: PermissionMode): PermissionMode {
  return MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
}
