/** Browser automation shapes shared by Core, the tools and the UI. */

export interface BrowserPageInfo {
  url: string;
  title: string;
}

/** Something on the page a click or keystroke can be aimed at. */
export interface BrowserControl {
  /** Accessible role, e.g. `button`, `link`, `textbox`. */
  role: string;
  name: string;
}

export interface BrowserLink {
  text: string;
  href: string;
}

export interface BrowserSnapshot extends BrowserPageInfo {
  /** Visible text, truncated to the limit the caller asked for. */
  text: string;
  truncated: boolean;
  links: BrowserLink[];
  controls: BrowserControl[];
}

export interface BrowserShot {
  path: string;
  bytes: number;
}
