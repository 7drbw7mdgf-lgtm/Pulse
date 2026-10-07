use serde::Deserialize;
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

struct BackendState(Mutex<Option<Child>>);
#[derive(Deserialize)]
struct Launch {
    port: u16,
    token: String,
}

fn launch_backend(app: &tauri::AppHandle) -> Result<(Child, Launch), Box<dyn std::error::Error>> {
    let backend = app
        .path()
        .resolve("resources/backend", tauri::path::BaseDirectory::Resource)?;
    let cache = match std::env::var_os("PULSE_CONFIG_DIR") {
        Some(path) => PathBuf::from(path),
        None => app.path().app_cache_dir()?,
    };
    fs::create_dir_all(&cache)?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(cache.join("backend.log"))?;
    let launch_path = cache.join(format!(
        "launch-{}-{}.json",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    ));
    let python = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    .into_iter()
    .find(|p| std::path::Path::new(p).is_file())
    .ok_or("Python 3 is required to open Pulse")?;
    let mut child = Command::new(python)
        .arg(backend.join("pulse_backend.py"))
        .current_dir(&backend)
        .env("PULSE_PORT", "0")
        .env("PULSE_LAUNCH_FILE", &launch_path)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(bytes) = fs::read(&launch_path) {
            if let Ok(launch) = serde_json::from_slice::<Launch>(&bytes) {
                fs::remove_file(&launch_path)?;
                return Ok((child, launch));
            }
        }
        if let Some(status) = child.try_wait()? {
            return Err(format!(
                "Pulse backend exited ({status}). Check backend.log in the app cache folder."
            )
            .into());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&launch_path);
            return Err(
                "Pulse backend did not become ready. Check backend.log in the app cache folder."
                    .into(),
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn stop_backend(app: &tauri::AppHandle) {
    if let Ok(mut lock) = app.state::<BackendState>().0.lock() {
        if let Some(mut child) = lock.take() {
            if let Err(error) = child.kill() {
                eprintln!("Could not stop Pulse backend: {error}");
            }
            if let Err(error) = child.wait() {
                eprintln!("Could not reap Pulse backend: {error}");
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BackendState(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let (child, launch) = launch_backend(&handle)?;
            *app.state::<BackendState>()
                .0
                .lock()
                .map_err(|_| "Backend state lock poisoned")? = Some(child);
            let url = format!(
                "http://127.0.0.1:{}/index.html?token={}",
                launch.port, launch.token
            )
            .parse()?;
            let open_navigation = handle.clone();
            let open_window = handle.clone();
            let port = launch.port;
            let result = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Pulse — Scientific Literature Discovery & Synthesis")
                .inner_size(1400.0, 920.0)
                .min_inner_size(1024.0, 720.0)
                .on_navigation(move |url| {
                    if url.host_str() == Some("127.0.0.1") && url.port() == Some(port) {
                        return true;
                    }
                    if matches!(url.scheme(), "blob" | "data") {
                        return true;
                    }
                    if matches!(url.scheme(), "https" | "http") {
                        if let Err(error) = open_navigation
                            .opener()
                            .open_url(url.as_str(), None::<&str>)
                        {
                            eprintln!("Could not open paper URL: {error}");
                        }
                    }
                    false
                })
                .on_download(|webview, event| {
                    match event {
                        tauri::webview::DownloadEvent::Requested { destination, .. } => {
                            if let Some(folder) = std::env::var_os("PULSE_EXPORT_DIR") {
                                if let Some(name) = destination.file_name() {
                                    *destination = PathBuf::from(folder).join(name);
                                }
                            }
                        }
                        tauri::webview::DownloadEvent::Finished { success, .. } => {
                            let message = if success {
                                "Export saved to Downloads"
                            } else {
                                "Export failed; please try again"
                            };
                            let _ = webview.eval(&format!(
                                "showToast({})",
                                serde_json::to_string(message).unwrap_or_default()
                            ));
                        }
                        _ => (),
                    }
                    true
                })
                .on_new_window(move |url, _| {
                    if matches!(url.scheme(), "https" | "http") {
                        if let Err(error) =
                            open_window.opener().open_url(url.as_str(), None::<&str>)
                        {
                            eprintln!("Could not open paper URL: {error}");
                        }
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build();
            if let Err(error) = result {
                stop_backend(&handle);
                return Err(error.into());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                stop_backend(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not initialise Pulse")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                stop_backend(app);
            }
        });
}
