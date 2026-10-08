fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "surface_name",
            "clock_sample",
            "core_heartbeat",
            "request_snapshot",
            "push_snapshot",
            "resolve_action",
            "report_action_stage",
            "surface_ready",
            "dispatch_action",
            "frontend_error",
        ]),
    ))
    .expect("desktop permission manifest");
}
