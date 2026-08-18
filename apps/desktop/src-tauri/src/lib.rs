#[cfg(target_os = "windows")]
use std::{
    fs::{self, File},
    io,
    net::{SocketAddr, TcpStream},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
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

#[cfg(target_os = "windows")]
fn extract_core_runtime(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let archive_file = File::open(archive_path)
        .map_err(|error| format!("Could not open bundled Core runtime: {error}"))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("Bundled Core runtime is not a valid ZIP: {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Could not read Core runtime entry: {error}"))?;
        let Some(relative_path) = entry.enclosed_name() else {
            return Err("Bundled Core runtime contains an unsafe path.".to_string());
        };
        let output_path = destination.join(relative_path);

        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("Could not create Core runtime folder: {error}"))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create Core runtime folder: {error}"))?;
        }
        let mut output_file = File::create(&output_path)
            .map_err(|error| format!("Could not create Core runtime file: {error}"))?;
        io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("Could not extract Core runtime file: {error}"))?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn ensure_core_runtime(app: &tauri::App) -> Result<Option<PathBuf>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve Jarvis resource directory: {error}"))?;
    let archive = resource_dir.join("core-runtime.zip");

    // Development builds intentionally do not require a packaged runtime. Developers can
    // keep running Core from a separate terminal while `tauri dev` is active.
    if !archive.exists() {
        return Ok(None);
    }

    let app_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve Jarvis local data directory: {error}"))?;
    let runtime_dir = app_data_dir.join("core-runtime-v0.2.0");
    let node = runtime_dir.join("node.exe");
    let entry = runtime_dir.join("app").join("src").join("main.ts");

    if node.exists() && entry.exists() {
        return Ok(Some(runtime_dir));
    }

    let staging_dir = app_data_dir.join("core-runtime-v0.2.0.tmp");
    let _ = fs::remove_dir_all(&staging_dir);
    fs::create_dir_all(&staging_dir)
        .map_err(|error| format!("Could not prepare Core runtime folder: {error}"))?;

    if let Err(error) = extract_core_runtime(&archive, &staging_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }

    if runtime_dir.exists() {
        fs::remove_dir_all(&runtime_dir)
            .map_err(|error| format!("Could not replace old Core runtime: {error}"))?;
    }
    fs::rename(&staging_dir, &runtime_dir)
        .map_err(|error| format!("Could not activate Core runtime: {error}"))?;

    if !node.exists() || !entry.exists() {
        return Err("Core runtime extracted, but required files are missing.".to_string());
    }

    Ok(Some(runtime_dir))
}

/// Start the production Core runtime shipped inside the installer. Development builds
/// deliberately skip this when the resource archive is absent.
#[cfg(target_os = "windows")]
fn start_bundled_core(app: &tauri::App) -> Result<Option<Child>, String> {
    if core_is_running() {
        return Ok(None);
    }

    let Some(runtime_dir) = ensure_core_runtime(app)? else {
        return Ok(None);
    };
    let node = runtime_dir.join("node.exe");
    let app_dir = runtime_dir.join("app");

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
            match start_bundled_core(app) {
                Ok(child) => {
                    if let Ok(mut slot) = core_child_setup.lock() {
                        *slot = child;
                    }
                }
                Err(error) => {
                    eprintln!("Jarvis Core startup failed: {error}");
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
