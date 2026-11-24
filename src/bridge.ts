/*
 * Pulse OS — React Native bridge wrapper.
 * Thin, typed access to the native PulseBridge module (accessibility service HUD,
 * automation guard, overlay permission). Every call degrades gracefully when the
 * native module is absent (Expo Go, iOS, web) so callers never need to guard.
 */
import { NativeModules, Platform } from 'react-native';

export type GuardState = {
  paused: boolean;
  lastActionSignature: string;
  repeatActionCount: number;
  lastLoopGuardHit: string;
  hudVisible: boolean;
};

export type BridgeActionStep = {
  actionType: string;
  target: string;
  status: string;
  latencyMs: number;
  detail: string;
  at: number;
};

export type BridgeAutomationResult = {
  status: string;
  message: string;
  cartVerified: boolean;
  cartSummary: string;
  screenshot: string;
  screenDump: string;
  ts: number;
  stepLogs: string[];
  bridgeSession?: string;
  actionSteps?: BridgeActionStep[];
};

type PulseBridgeNative = {
  showTacticalHUD?: (message: string | null) => Promise<boolean>;
  hideTacticalHUD?: () => Promise<boolean>;
  haltAutomation?: () => Promise<boolean>;
  resumeAutomation?: () => Promise<boolean>;
  getAutomationGuardState?: () => Promise<GuardState>;
  hasOverlayPermission?: () => Promise<boolean>;
  openSystemSettings?: (panel: string | null) => Promise<boolean>;
  getAutomationResult?: () => Promise<BridgeAutomationResult>;
  isAccessibilityEnabled?: () => Promise<boolean>;
  openAccessibilitySettings?: () => Promise<boolean>;
};

function native(): PulseBridgeNative | null {
  try {
    return (NativeModules as any)?.PulseBridge ?? null;
  } catch {
    return null;
  }
}

/** True when the native bridge module is present (i.e. a real Android build). */
export function bridgeAvailable(): boolean {
  return native() != null;
}

/** True when the accessibility service is connected and can drive the HUD. */
export async function isAccessibilityEnabled(): Promise<boolean> {
  try {
    const b = native();
    if (!b?.isAccessibilityEnabled) return false;
    return !!(await b.isAccessibilityEnabled());
  } catch {
    return false;
  }
}

/** Shows the tactical HUD overlay. Returns false when unavailable. */
export async function showTacticalHUD(message = 'PULSE ARMED'): Promise<boolean> {
  try {
    const b = native();
    if (!b?.showTacticalHUD) return false;
    return !!(await b.showTacticalHUD(message));
  } catch {
    return false;
  }
}

/** Hides the tactical HUD overlay. */
export async function hideTacticalHUD(): Promise<boolean> {
  try {
    const b = native();
    if (!b?.hideTacticalHUD) return false;
    return !!(await b.hideTacticalHUD());
  } catch {
    return false;
  }
}

/** Pauses automation (the loop guard and every action handler respect this). */
export async function haltAutomation(): Promise<boolean> {
  try {
    const b = native();
    if (!b?.haltAutomation) return false;
    return !!(await b.haltAutomation());
  } catch {
    return false;
  }
}

/** Resumes a halted automation run. */
export async function resumeAutomation(): Promise<boolean> {
  try {
    const b = native();
    if (!b?.resumeAutomation) return false;
    return !!(await b.resumeAutomation());
  } catch {
    return false;
  }
}

/** Reads the current automation guard state (paused flag, repeat counter, loop-guard hit). */
export async function getAutomationGuardState(): Promise<GuardState | null> {
  try {
    const b = native();
    if (!b?.getAutomationGuardState) return null;
    return await b.getAutomationGuardState();
  } catch {
    return null;
  }
}

/** True when the app may draw over other apps (required for the tactical HUD). */
export async function hasOverlayPermission(): Promise<boolean> {
  try {
    const b = native();
    if (!b?.hasOverlayPermission) return false;
    return !!(await b.hasOverlayPermission());
  } catch {
    return false;
  }
}

/** Opens a system settings panel. "overlay" jumps straight to this app's overlay permission page. */
export async function openSystemSettings(panel: string): Promise<boolean> {
  try {
    const b = native();
    if (!b?.openSystemSettings) return false;
    return !!(await b.openSystemSettings(panel));
  } catch {
    return false;
  }
}

/** Opens the "Display over other apps" permission page for Pulse OS. */
export async function openOverlaySettings(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  return openSystemSettings('overlay');
}

/** Opens the accessibility settings page so the user can enable the Pulse service. */
export async function openAccessibilitySettings(): Promise<boolean> {
  try {
    const b = native();
    if (!b?.openAccessibilitySettings) return false;
    return !!(await b.openAccessibilitySettings());
  } catch {
    return false;
  }
}

/** Reads the latest automation result, including structured action steps and the persisted bridge session. */
export async function getAutomationResult(): Promise<BridgeAutomationResult | null> {
  try {
    const b = native();
    if (!b?.getAutomationResult) return null;
    return await b.getAutomationResult();
  } catch {
    return null;
  }
}
