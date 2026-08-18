# Computer-use feasibility spike (throwaway)

Go/no-go experiment for the "operate Windows" pillar. It asks one question per app:
**can Jarvis see and drive this UI reliably enough to automate it?**

Nothing in here is imported by Jarvis Core, and nothing here is meant to survive into
the product. It is a measurement tool.

## What it measures

For File Explorer, Windows Settings, Notepad, VS Code and Edge/Chrome:

| Measurement | Why it matters |
| --- | --- |
| Window discovery time | Packaged apps (Settings) host their window in `ApplicationFrameHost.exe`, so class/title matching is the only reliable hook. |
| Subtree element count | An empty tree means the app is opaque to UI Automation (common for GPU-composited canvases). |
| Elements with an `AutomationId` | Without a stable id, targeting falls back to names or coordinates, which break on localisation, resize and scroll. |
| Invokable elements | Whether anything can actually be clicked through UIA rather than synthetic input. |
| Edit fields + `ValuePattern` write | Whether text can be entered without keystroke injection. |
| Full tree walk duration | Above ~2s, closed-loop control is impractical: the UI changes faster than Jarvis can observe it. |
| GDI window capture | Whether the screenshot + coordinate fallback is available at all (some windows return black frames). |

## Running it (Windows 11 x64 only)

```powershell
cd scripts\spike-computeruse
cargo run --release                       # all five apps, inspection only
cargo run --release -- --app notepad --allow-input   # also attempts a ValuePattern write
cargo run --release -- --app settings --timeout 30
```

Flags:

- `--app <explorer|settings|notepad|vscode|browser>` — probe a single app (repeatable).
- `--allow-input` — permit the write probe (currently Notepad only). Off by default.
- `--timeout <seconds>` — how long to wait for a window (default 15).
- `--out <dir>` — output directory (default `out/`).

Outputs, all under `out/` and git-ignored:

- `REPORT.md` — the per-app reliability report.
- `findings.json` — raw measurements.
- `<app>.bmp` — captured window, proving the coordinate fallback works.

VS Code and Edge/Chrome must already be installed and on `PATH` (`code`, `msedge`).
Chromium-based apps only expose an accessibility tree once an assistive client asks
for it; the spike triggers this by attaching UIA, but the first probe can come back
sparse — re-run it once the window has settled.

## Status of the findings

The probe code compiles for `x86_64-pc-windows-*` but has **not** been executed on
Windows yet (it was authored on Linux). `REPORT.md` in this folder is the methodology
plus the hypotheses to confirm; the generated `out/REPORT.md` from a real run is the
authoritative artefact.
