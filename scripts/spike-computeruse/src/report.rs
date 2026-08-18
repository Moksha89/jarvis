use crate::findings::Finding;

/// Renders the go/no-go report. Only measured values appear here.
pub fn render(findings: &[Finding], allow_input: bool) -> String {
    let mut out = String::new();
    out.push_str("# Computer-use feasibility spike - results\n\n");
    out.push_str(&format!(
        "- Run at: {}\n- Input probes: {}\n\n",
        now(),
        if allow_input { "enabled (--allow-input)" } else { "disabled" }
    ));

    out.push_str("| App | Window | UIA elements | With AutomationId | Invokable | Edit fields | Tree walk | Screenshot | Verdict |\n");
    out.push_str("| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
    for finding in findings {
        out.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {} ms | {} | {} |\n",
            finding.app,
            if finding.window_found { "found" } else { "not found" },
            finding.subtree_elements,
            finding.elements_with_automation_id,
            finding.invokable_elements,
            finding.editable_elements,
            finding.tree_walk_ms,
            if finding.screenshot_ok { "ok" } else { "failed" },
            finding.verdict(),
        ));
    }

    out.push_str("\n## Per-app detail\n");
    for finding in findings {
        out.push_str(&format!("\n### {}\n\n", finding.app));
        out.push_str(&format!("- Launched: {}\n", finding.launched));
        out.push_str(&format!(
            "- Window: `{}` (class `{}`), appeared after {} ms\n",
            finding.window_title, finding.window_class, finding.window_wait_ms
        ));
        out.push_str(&format!("- UIA root name: `{}`\n", finding.uia_root_name));
        if let Some((width, height)) = finding.screenshot_size {
            out.push_str(&format!(
                "- Screenshot: {}x{} at `{}`\n",
                width, height, finding.screenshot_path
            ));
        }
        if let Some(write) = finding.value_pattern_write {
            out.push_str(&format!("- ValuePattern write: {}\n", if write { "succeeded" } else { "failed" }));
        }
        for note in &finding.notes {
            out.push_str(&format!("- Note: {note}\n"));
        }
        for error in &finding.errors {
            out.push_str(&format!("- Error: {error}\n"));
        }
    }

    out.push_str("\n## How to read this\n\n");
    out.push_str(
        "`AutomationId` coverage is the key number: elements without one can only be targeted by \
name or coordinates, which breaks as soon as the window is localised, resized or scrolled. \
A tree walk above roughly two seconds makes closed-loop control impractical because the UI \
changes faster than Jarvis can observe it.\n",
    );
    out
}

fn now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("unix {seconds}")
}
