/// The five apps the spike must reach. Each is matched by window class and/or
/// title because process names are unreliable for packaged (UWP) apps such as
/// Windows Settings, which host their UI inside ApplicationFrameHost.exe.
#[derive(Clone)]
pub struct Target {
    pub key: &'static str,
    pub label: &'static str,
    /// Command used to launch the app, executed through `cmd /c start`.
    pub launch: &'static str,
    /// Window classes that identify the app's main window.
    pub window_classes: &'static [&'static str],
    /// Substrings the window title may contain (case-insensitive); any match wins.
    /// Empty means "any non-empty title".
    pub title_contains: &'static [&'static str],
    /// Whether the spike is allowed to type into the app when `--allow-input` is set.
    pub input_probe: bool,
}

pub const TARGETS: &[Target] = &[
    Target {
        key: "explorer",
        label: "File Explorer",
        launch: "explorer.exe",
        window_classes: &["CabinetWClass", "ExplorerWClass"],
        title_contains: &[],
        input_probe: false,
    },
    Target {
        key: "settings",
        label: "Windows Settings",
        launch: "ms-settings:",
        window_classes: &["ApplicationFrameWindow", "Windows.UI.Core.CoreWindow"],
        title_contains: &["settings"],
        input_probe: false,
    },
    Target {
        key: "notepad",
        label: "Notepad",
        launch: "notepad.exe",
        window_classes: &["Notepad", "ApplicationFrameWindow"],
        title_contains: &["notepad"],
        input_probe: true,
    },
    Target {
        key: "vscode",
        label: "Visual Studio Code",
        launch: "code",
        window_classes: &["Chrome_WidgetWin_1"],
        title_contains: &["visual studio code"],
        input_probe: false,
    },
    Target {
        key: "browser",
        label: "Chrome or Edge",
        launch: "msedge",
        window_classes: &["Chrome_WidgetWin_1"],
        title_contains: &["edge", "chrome"],
        input_probe: false,
    },
];

pub fn find(key: &str) -> Option<&'static Target> {
    TARGETS.iter().find(|target| target.key == key)
}
