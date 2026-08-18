# Computer-use feasibility - method and expected findings

Status: **the probe compiles for Windows but has not yet been run on Windows hardware.**
Run `cargo run --release` on the target machine; it writes the authoritative
`out/REPORT.md` with measured numbers. This file describes what is measured and what we
expect, so the real report can be read as a confirmation or a contradiction.

## Decision rule

The spike classifies each app from measured values only:

- **go** — accessibility tree is non-empty, at least 40% of elements carry an
  `AutomationId`, invokable elements exist, and a full subtree walk finishes in under
  2 seconds.
- **partial** — controllable, but element identity is weak or the tree is slow, so a
  screenshot + coordinate fallback is required.
- **no-go** — no window found, or the tree is empty; only pixel-level automation remains.

## Hypotheses to confirm or refute

| App | Expected | Reasoning |
| --- | --- | --- |
| Notepad | go | Classic Win32 edit control with `ValuePattern`; the most automatable of the five. |
| File Explorer | go / partial | Rich UIA tree, but list items are virtualised, so off-screen items are invisible until scrolled. |
| Windows Settings | partial | XAML islands expose good `AutomationId`s, yet the window lives in `ApplicationFrameHost.exe` and pages load asynchronously, so probes race the UI. |
| VS Code | partial / no-go | Electron only builds an accessibility tree when it detects a screen reader; the editor surface is a canvas, so text targeting may be unavailable. |
| Chrome / Edge | partial | Chromium exposes a tree on demand and it can be very large; a full subtree walk is likely the slowest of the five. |

## What a "no" would mean for Jarvis

If two or more of these come back **no-go**, "operate Windows" cannot rest on UI
Automation alone: it would need per-app adapters plus a vision/coordinate loop, which is
a materially larger investment than the MVP assumed. That is the decision this spike
exists to inform — which is why it is deliberately outside Core.
