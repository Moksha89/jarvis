#[cfg(target_os = "windows")]
use std::{
    net::{SocketAddr, TcpStream},
    os::windows::process::CommandExt,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::{Manager, WindowEvent};

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

#[cfg(target_os = "windows")]
fn core_is_running() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], 47_821));
    TcpStream::connect_timeout(&address, Duration::from_millis(180)).is_ok()
}

/// Start the production Core runtime shipped inside the installer. Development builds
/// deliberately skip this when the resource is absent, so developers can still run Core
/// in a separate terminal.
#[cfg(target_os = "windows")]
fn start_bundled_core(app: &tauri::App) -> Result<Option<Child>, String> {
    if core_is_running() {
        return Ok(None);
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve Jarvis resource directory: {error}"))?;
    let runtime_dir = resource_dir.join("core");
    let node = runtime_dir.join("node.exe");
    let app_dir = runtime_dir.join("app");
    let entry = app_dir.join("src").join("main.ts");

    // In `tauri dev` the packaged runtime does not exist. The normal developer workflow
    // starts Core separately, so absence here is not an application error.
    if !node.exists() || !entry.exists() {
        return Ok(None);
    }

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new(node)
        .current_dir(&app_dir)
        .arg("--import")
        .arg("tsx")
        .arg("src/main.ts")
        .env("JARVIS_ENABLE_AGENT", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(Some)
        .map_err(|error| format!("Could not start bundled Jarvis Core: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    let core_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    #[cfg(target_os = "windows")]
    let core_child_setup = Arc::clone(&core_child);
    #[cfg(target_os = "windows")]
    let core_child_window = Arc::clone(&core_child);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![core_base_url, reveal_in_explorer])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Jarvis");
            }

            #[cfg(target_os = "windows")]
            if let Ok(child) = start_bundled_core(app) {
                if let Ok(mut slot) = core_child_setup.lock() {
                    *slot = child;
                }
            }

            Ok(())
        });

    #[cfg(target_os = "windows")]
    let builder = builder.on_window_event(move |_window, event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Ok(mut slot) = core_child_window.lock() {
                if let Some(child) = slot.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                *slot = None;
            }
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running Jarvis");
}
