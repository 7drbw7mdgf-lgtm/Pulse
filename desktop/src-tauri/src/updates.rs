//! Signed GitHub updates, staged separately from the user's library.
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

const REPOSITORY: &str = "7drbw7mdgf-lgtm/Pulse";
const MAX_PACKAGE: u64 = 1024 * 1024 * 1024;

#[derive(Default)]
struct Session {
    update: Option<Update>,
    ready: bool,
    cancel: Option<oneshot::Sender<()>>,
}
#[derive(Default)]
pub struct UpdateState {
    pub port: Mutex<Option<u16>>,
    session: AsyncMutex<Session>,
    busy: AtomicBool,
    pub installing: AtomicBool,
}
struct Operation<'a>(&'a AtomicBool);
impl<'a> Operation<'a> {
    fn begin(flag: &'a AtomicBool) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self(flag))
            .map_err(|_| "An update operation is already running.".into())
    }
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Preferences {
    auto_download: bool,
    last_checked: u64,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            auto_download: true,
            last_checked: 0,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    available_version: Option<String>,
    notes: Option<String>,
    ready: bool,
    auto_download: bool,
    last_checked: u64,
    can_update: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

fn authorize(window: &WebviewWindow, state: &UpdateState) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|_| "The Pulse window is unavailable.")?;
    let port = *state
        .port
        .lock()
        .map_err(|_| "Update state is unavailable.")?;
    if window.label() != "main"
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != port
        || port.is_none()
    {
        return Err("Updates are available only from the Pulse desktop window.".into());
    }
    Ok(())
}
fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|p| p.join("updates"))
        .map_err(|_| "The update cache is unavailable.".into())
}
fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("update-settings.json"))
        .map_err(|_| "Update settings are unavailable.".into())
}
fn preferences(app: &AppHandle) -> Preferences {
    preferences_path(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Invalid update cache.")?;
    fs::create_dir_all(parent).map_err(|e| format!("Could not create update storage: {e}"))?;
    let temp = path.with_extension(format!("{}.partial", std::process::id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e: std::io::Error| {
        format!("Could not save the update. Check free disk space and retry: {e}")
    })
}
fn save_preferences(app: &AppHandle, value: &Preferences) -> Result<(), String> {
    private_write(
        &preferences_path(app)?,
        &serde_json::to_vec(value).map_err(|e| e.to_string())?,
    )
}
fn can_update() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::env::current_exe()
            .map(|p| {
                !p.starts_with("/Volumes")
                    && p.ancestors()
                        .any(|p| p.extension().is_some_and(|x| x == "app"))
            })
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        cfg!(windows)
    }
}
fn validate_asset(version: &str, url: &tauri::Url) -> Result<(), String> {
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("This update has an unsupported release version.".into());
    }
    let suffix = if cfg!(target_os = "macos") {
        "macOS-arm64.app.tar.gz"
    } else {
        "Windows-x64-Setup.exe"
    };
    let expected = format!("/{REPOSITORY}/releases/download/v{version}/Pulse-{version}-{suffix}");
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != expected
    {
        return Err("The update must come from the official Pulse GitHub release.".into());
    }
    Ok(())
}
fn package_path(app: &AppHandle, update: &Update) -> Result<PathBuf, String> {
    validate_asset(&update.version, &update.download_url)?;
    Ok(folder(app)?.join(format!("Pulse-{}.bin", update.version)))
}
fn cached_bytes(path: &Path, update: &Update) -> Result<Vec<u8>, String> {
    let size = fs::metadata(path)
        .map_err(|_| "The update is not downloaded yet.")?
        .len();
    if size == 0 || size > MAX_PACKAGE {
        return Err("The cached update has an invalid size. Download it again.".into());
    }
    let bytes = fs::read(path).map_err(|_| "Could not read the downloaded update.")?;
    update
        .verify(&bytes)
        .map_err(|_| "The update failed signature verification. Download it again.".to_string())?;
    Ok(bytes)
}
fn cleanup_cache(folder: &Path, keep: Option<&Path>) {
    if let Ok(entries) = fs::read_dir(folder) {
        for entry in entries.flatten() {
            let path = entry.path();
            if keep == Some(path.as_path()) {
                continue;
            }
            if path.is_file()
                && path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("Pulse-"))
                && matches!(
                    path.extension().and_then(|x| x.to_str()),
                    Some("bin" | "partial")
                )
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}
async fn info(app: &AppHandle, state: &UpdateState) -> UpdateInfo {
    let prefs = preferences(app);
    let session = state.session.lock().await;
    UpdateInfo {
        current_version: app.package_info().version.to_string(),
        available_version: session.update.as_ref().map(|u| u.version.clone()),
        notes: session.update.as_ref().and_then(|u| u.body.clone()),
        ready: session.ready,
        auto_download: prefs.auto_download,
        last_checked: prefs.last_checked,
        can_update: can_update(),
    }
}
#[tauri::command]
pub async fn pulse_update_info(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, String> {
    authorize(&window, &state)?;
    Ok(info(&app, &state).await)
}
#[tauri::command]
pub async fn pulse_update_preferences(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
    auto_download: bool,
) -> Result<UpdateInfo, String> {
    authorize(&window, &state)?;
    let mut prefs = preferences(&app);
    prefs.auto_download = auto_download;
    save_preferences(&app, &prefs)?;
    Ok(info(&app, &state).await)
}
#[tauri::command]
pub async fn pulse_update_check(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, String> {
    authorize(&window, &state)?;
    let _operation = Operation::begin(&state.busy)?;
    let exit_handle = app.clone();
    let update = app.updater_builder().timeout(Duration::from_secs(20)).on_before_exit(move || {
        super::stop_backend(&exit_handle); exit_handle.cleanup_before_exit();
    }).build().map_err(|e| e.to_string())?.check().await.map_err(|e| match e {
        tauri_plugin_updater::Error::ReleaseNotFound => "GitHub has no signed update feed yet. Try again after the new release is published.".to_string(),
        _ => format!("Could not check GitHub for updates. Check your connection and try again: {e}"),
    })?;
    let mut ready = false;
    if let Some(ref update) = update {
        let path = package_path(&app, update)?;
        if path.exists() {
            let item = update.clone();
            let file = path.clone();
            ready =
                tauri::async_runtime::spawn_blocking(move || cached_bytes(&file, &item).is_ok())
                    .await
                    .unwrap_or(false);
            if !ready {
                let _ = fs::remove_file(&path);
            }
        }
        cleanup_cache(&folder(&app)?, Some(&path));
    } else {
        cleanup_cache(&folder(&app)?, None);
    }
    {
        let mut session = state.session.lock().await;
        session.update = update;
        session.ready = ready;
    }
    let mut prefs = preferences(&app);
    prefs.last_checked = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    save_preferences(&app, &prefs)?;
    Ok(info(&app, &state).await)
}
#[tauri::command]
pub async fn pulse_update_download(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
    on_event: Channel<Progress>,
) -> Result<UpdateInfo, String> {
    authorize(&window, &state)?;
    if !can_update() {
        return Err("Move Pulse to Applications before updating it.".into());
    }
    let _operation = Operation::begin(&state.busy)?;
    let (sender, receiver) = oneshot::channel();
    let mut update = {
        let mut session = state.session.lock().await;
        let update = session.update.clone().ok_or("Check for updates first.")?;
        session.cancel = Some(sender);
        update
    };
    let path = package_path(&app, &update)?;
    update.timeout = Some(Duration::from_secs(30 * 60));
    let mut downloaded = 0u64;
    let mut last = Instant::now() - Duration::from_secs(1);
    let (limit_sender, limit_receiver) = oneshot::channel();
    let mut limit_sender = Some(limit_sender);
    let _ = on_event.send(Progress {
        phase: "downloading",
        downloaded: 0,
        total: None,
    });
    let result = tokio::select! {
        _ = receiver => Err("Update download cancelled. You can retry later.".to_string()),
        _ = limit_receiver => Err("The update is larger than the supported package size.".to_string()),
        result = update.download(|chunk, total| {
            downloaded += chunk as u64;
            if downloaded > MAX_PACKAGE || total.is_some_and(|n| n > MAX_PACKAGE) {
                if let Some(sender) = limit_sender.take() { let _ = sender.send(()); }
            }
            if last.elapsed() >= Duration::from_millis(100) {
                let _ = on_event.send(Progress { phase: "downloading", downloaded, total }); last = Instant::now();
            }
        }, || { let _ = on_event.send(Progress { phase: "verifying", downloaded: 0, total: None }); }) => result.map_err(|e| format!("The update could not be downloaded and verified: {e}")),
    };
    state.session.lock().await.cancel = None;
    let bytes = result?;
    tauri::async_runtime::spawn_blocking(move || private_write(&path, &bytes))
        .await
        .map_err(|e| e.to_string())??;
    state.session.lock().await.ready = true;
    Ok(info(&app, &state).await)
}
#[tauri::command]
pub async fn pulse_update_cancel(
    window: WebviewWindow,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    authorize(&window, &state)?;
    if let Some(cancel) = state.session.lock().await.cancel.take() {
        let _ = cancel.send(());
    }
    Ok(())
}
#[tauri::command]
pub async fn pulse_update_install(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    authorize(&window, &state)?;
    if !can_update() {
        return Err("Move Pulse to Applications before updating it.".into());
    }
    let _operation = Operation::begin(&state.busy)?;
    let update = {
        let session = state.session.lock().await;
        if !session.ready {
            return Err("Download the update before restarting.".into());
        }
        session.update.clone().ok_or("Check for updates first.")?
    };
    let path = package_path(&app, &update)?;
    let handle = app.clone();
    state.installing.store(true, Ordering::SeqCst);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bytes = cached_bytes(&path, &update)?;
        // Frontend has confirmed a durable save before invoking this command.
        #[cfg(target_os = "macos")] super::stop_backend(&handle);
        match update.install(bytes) {
            Ok(()) => { let _ = fs::remove_file(&path); handle.restart(); }
            Err(error) => {
                #[cfg(target_os = "macos")]
                if let Ok((child, launch)) = super::launch_backend(&handle) {
                    if let Ok(mut state) = handle.state::<super::BackendState>().0.lock() { *state = Some(child); }
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Ok(url) = format!("http://127.0.0.1:{}/index.html?token={}", launch.port, launch.token).parse() {
                            if let Ok(mut port) = handle.state::<UpdateState>().port.lock() { *port = Some(launch.port); }
                            let _ = window.navigate(url);
                        }
                    }
                }
                Err(format!("Pulse could not install the update. Your library is saved. Check the app folder's permissions and retry: {error}"))
            }
        }
    }).await.map_err(|e| e.to_string());
    state.installing.store(false, Ordering::SeqCst);
    result?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assets_require_official_versioned_github_release() {
        let suffix = if cfg!(target_os = "macos") {
            "macOS-arm64.app.tar.gz"
        } else {
            "Windows-x64-Setup.exe"
        };
        let valid = format!(
            "https://github.com/{REPOSITORY}/releases/download/v2.1.3/Pulse-2.1.3-{suffix}"
        );
        assert!(validate_asset("2.1.3", &valid.parse().unwrap()).is_ok());
        for invalid in [
            valid.replace("https:", "http:"),
            valid.replace("github.com/", "github.com.evil.test/"),
            valid.replace(REPOSITORY, "other/repo"),
            format!("{valid}?token=bad"),
            valid.replace("/v2.1.3/", "/v2.0.1/"),
        ] {
            assert!(validate_asset("2.1.3", &invalid.parse().unwrap()).is_err());
        }
        assert!(validate_asset("../../bad", &valid.parse().unwrap()).is_err());
    }
    #[test]
    fn operations_serialize_and_recover_after_failure() {
        let busy = AtomicBool::new(false);
        {
            let _first = Operation::begin(&busy).unwrap();
            assert!(Operation::begin(&busy).is_err());
        }
        assert!(Operation::begin(&busy).is_ok());
    }
    #[test]
    fn preferences_keep_automatic_download_choice() {
        let value: Preferences =
            serde_json::from_str("{\"autoDownload\":false,\"lastChecked\":42}").unwrap();
        assert!(!value.auto_download);
        assert_eq!(value.last_checked, 42);
        assert!(
            serde_json::from_str::<Preferences>("{}")
                .unwrap()
                .auto_download
        );
    }
    async fn fixture_update(version: &str) -> Option<Update> {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = serde_json::json!({"version":version,"url":format!("http://{address}/payload"),
            "signature":include_str!("../tests/fixtures/update.sig").trim()})
        .to_string();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).unwrap();
        });
        // This local fixture is compiled only into tests; production has a fixed HTTPS GitHub feed.
        let config = serde_json::json!({
            "pubkey":include_str!("../tests/fixtures/update.pub").trim(),"requireSignedVersion":true,"endpoints":[]
        });
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), config);
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let result = app
            .updater_builder()
            .endpoints(vec![format!("http://{address}/latest.json")
                .parse()
                .unwrap()])
            .unwrap()
            .build()
            .unwrap()
            .check()
            .await
            .unwrap();
        server.join().unwrap();
        result
    }
    #[tokio::test]
    async fn signatures_reject_corruption_and_signed_version_substitution() {
        let payload = include_bytes!("../tests/fixtures/payload.txt");
        let update = fixture_update("2.1.3").await.unwrap();
        update.verify(payload).unwrap();
        let mut corrupted = payload.to_vec();
        corrupted[0] ^= 1;
        assert!(update.verify(&corrupted).is_err());
        let substituted = fixture_update("2.1.4").await.unwrap();
        assert!(substituted.verify(payload).is_err());
        assert!(fixture_update("0.0.1").await.is_none());
    }
}
