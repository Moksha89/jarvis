use serde::Serialize;

/// One probe result per app. Everything here is measured, never assumed, so the
/// report can be trusted as a go/no-go signal.
#[derive(Debug, Default, Serialize)]
pub struct Finding {
    pub app: String,
    pub launched: bool,
    pub window_found: bool,
    pub window_title: String,
    pub window_class: String,
    /// Milliseconds from launch to a usable top-level window.
    pub window_wait_ms: u128,
    pub uia_root_name: String,
    /// Elements returned by a full subtree FindAll.
    pub subtree_elements: usize,
    /// Elements that expose a stable AutomationId (the ones we could target reliably).
    pub elements_with_automation_id: usize,
    pub invokable_elements: usize,
    pub editable_elements: usize,
    /// Milliseconds for the full subtree walk. Slow trees make control impractical.
    pub tree_walk_ms: u128,
    pub value_pattern_write: Option<bool>,
    pub screenshot_ok: bool,
    pub screenshot_path: String,
    pub screenshot_size: Option<(u32, u32)>,
    pub notes: Vec<String>,
    pub errors: Vec<String>,
}

impl Finding {
    pub fn new(app: &str) -> Self {
        Self { app: app.to_string(), ..Default::default() }
    }

    /// Coarse verdict used in the report table.
    pub fn verdict(&self) -> &'static str {
        if !self.window_found {
            return "no-go (app or window not reachable)";
        }
        if self.subtree_elements == 0 {
            return "no-go (accessibility tree empty - screenshot fallback only)";
        }
        let coverage = if self.subtree_elements == 0 {
            0.0
        } else {
            self.elements_with_automation_id as f64 / self.subtree_elements as f64
        };
        if coverage >= 0.4 && self.invokable_elements > 0 && self.tree_walk_ms < 2_000 {
            "go (UIA is reliable enough to target elements)"
        } else if self.invokable_elements > 0 {
            "partial (UIA works but element identity is weak; needs screenshot fallback)"
        } else {
            "partial (inspection only; no invokable elements found)"
        }
    }
}
