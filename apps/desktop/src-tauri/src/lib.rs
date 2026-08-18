#[cfg(target_os = "windows")]
use std::process::Command;

use tauri::Manager;

/// Where the webview should reach Jarvis Core. Kept in Rust so a packaged build can
/// override the port without rebuilding the frontend.
#[tauri::command]
fn core_base_url() -> String {
    std::env::var("JARVIS_CORE_URL").unwrap_or_else(|_| "http://127.0.0.1:47821".to_string())
}

/// Opens a path with the Windows shell. Used only for "reveal in Explorer" style
/// affordances; all file access goes through Core's permission engine.
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("Only supported on Windows".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![core_base_url, reveal_in_explorer])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Jarvis");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Jarvis");
}
