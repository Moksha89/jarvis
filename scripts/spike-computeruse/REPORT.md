# Computer-use feasibility - method and expected findings

Status: **measured on Windows (Windows Server 2022 x64, `cargo run --release -- --allow-input`).**
Each run rewrites `out/REPORT.md` (git-ignored) with the machine's own numbers; the table
below records the first real run so the hypotheses can be read as confirmed or refuted.

## Measured run

| App | Window | UIA elements | With AutomationId | Invokable | Edit fields | Tree walk | Screenshot | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| File Explorer | found | 101 | 44 | 23 | 17 | 319 ms | ok | go |
| Windows Settings | found | 40 | 16 | 11 | 1 | 189 ms | ok | go |
| Notepad | found | 27 | 10 | 7 | 1 | 300 ms | ok | partial |
| Visual Studio Code | found | 13 | 0 | 3 | 0 | 67 ms | ok | partial |
| Chrome / Edge | found | 46 | 2 | 16 | 1 | 81 ms | ok | partial |

Verdict for the MVP: **UI Automation is viable.** All five windows were found, every
subtree walk finished well under the 2 s budget, GDI screenshots captured for all five,
and `ValuePattern.SetValue` wrote text into Notepad's edit control on the first attempt.
Nothing came back no-go, so "operate Windows" does not need a per-app adapter zoo.

The refuted hypothesis is Notepad: it landed on `partial`, not `go`, because only 10 of
its 27 elements carry an `AutomationId` (below the 40% bar) even though writing to it
works. The Chromium-based apps (VS Code, Chrome/Edge) expose a tree but almost no
`AutomationId`s, so those two need the screenshot + coordinate fallback the spike
predicted.

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
