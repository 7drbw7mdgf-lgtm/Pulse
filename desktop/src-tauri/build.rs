fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pulse_update_info",
            "pulse_update_check",
            "pulse_update_download",
            "pulse_update_cancel",
            "pulse_update_preferences",
            "pulse_update_install",
        ]),
    ))
    .expect("Could not build Pulse desktop permissions");
}
