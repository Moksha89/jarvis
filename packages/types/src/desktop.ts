/** Windows desktop (computer use) shapes shared by Core, the tools and the UI. */

/** A screen rectangle in physical pixels. */
export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindow {
  /** Win32 window handle as a decimal string, stable while the window is open. */
  handle: string;
  title: string;
  process: string;
  pid: number;
  bounds: DesktopRect;
  foreground: boolean;
}

export interface DesktopElement {
  name: string;
  /** UI Automation control type, e.g. `Button`, `Edit`, `ListItem`. */
  role: string;
  automationId: string;
  enabled: boolean;
  depth: number;
  bounds?: DesktopRect;
}

export interface DesktopShot {
  path: string;
  width: number;
  height: number;
  bytes: number;
}

export type MouseButton = 'left' | 'right' | 'double';
