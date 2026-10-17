// Closing the window can hide it instead of quitting: the page, the Browser
// and Computer Use hosts, keep-awake and turn notifications all stay alive,
// and reopening shows the same document. Windows and Linux get a tray icon as
// the way back; macOS keeps its Dock icon. Settings choose hide to tray (the
// default) or quit; closing never asks (user: 옵션에서 트레이로. 진짜종료
// 두개 디폴트는 트레이로).

export interface BackgroundWindowOptions {
  /** The runInBackground setting: true hides to the tray, false quits. */
  enabled(): boolean;
  /** An approved quit, installer restart or relaunch: closes go through. */
  quitting(): boolean;
}

export interface BackgroundWindow {
  /** The window's `close` listener: prevents the close and hides instead. */
  onClose(event: { preventDefault(): void }, hide: () => void): void;
}

export function createBackgroundWindow(options: BackgroundWindowOptions): BackgroundWindow {
  return {
    onClose(event, hide) {
      if (options.quitting() || !options.enabled()) return;
      event.preventDefault();
      hide();
    },
  };
}

export const SOFTON_BACKGROUND_ARGUMENT = '--softon-hub-background';

export function isSoftonBackgroundRequest(argv: readonly string[]): boolean {
  return argv.includes(SOFTON_BACKGROUND_ARGUMENT);
}

/** Hide only the first local window, never a later user-opened connection. */
export function createBackgroundStartup(argv: readonly string[]) {
  let pending = isSoftonBackgroundRequest(argv);
  return {
    takeForWindow(local: boolean): boolean {
      if (!local || !pending) return false;
      pending = false;
      return true;
    },
  };
}

export function restoreStartupMaximization(
  window: { maximize(): void; once(event: 'show', listener: () => void): unknown },
  maximized: boolean,
  startHidden: boolean
): void {
  if (!maximized) return;
  // Electron maximize() also shows a hidden window. Defer it until an
  // explicit user reveal rather than undoing the background launch.
  if (startHidden) window.once('show', () => window.maximize());
  else window.maximize();
}
