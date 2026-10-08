#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::oneshot;
#[cfg(windows)]
mod hotkeys;
mod materials;
mod startup;
mod diagnostics;
#[cfg(debug_assertions)]
mod smoke;

#[cfg(windows)]
struct ShortcutState {
    service: Mutex<Option<hotkeys::Service>>,
    help: String,
    #[cfg(debug_assertions)]
    events: Mutex<Vec<Value>>,
}
#[cfg(windows)]
fn install_shortcuts(app: &tauri::AppHandle, enabled: bool) {
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<hotkeys::Binding>(32);
    let service = if enabled {
        hotkeys::Service::start(hotkeys::BINDINGS.to_vec(), move |binding| {
            let _ = sender.try_send(binding);
        })
    } else {
        drop(sender);
        Err(std::io::Error::other("诊断模式未注册全局快捷键"))
    };
    let help = match &service {
        Ok(service) => service
            .registrations
            .iter()
            .map(|registration| {
                let status = match registration.error {
                    None => "已启用".to_string(),
                    Some(1409) => "已被其他程序占用".to_string(),
                    Some(code) => format!("未能启用（{code}）"),
                };
                format!("{} — {status}", registration.binding.label)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Err(error) => format!("快捷键未启用：{error}"),
    };
    app.manage(ShortcutState {
        service: Mutex::new(service.ok()),
        help,
        #[cfg(debug_assertions)]
        events: Mutex::new(Vec::new()),
    });
    let keyboard_app = app.clone();
    // Preserve the order of rapid key presses instead of racing async play/seek actions.
    tauri::async_runtime::spawn(async move {
        while let Some(binding) = receiver.recv().await {
            let state = keyboard_app.state::<NativeState>();
            if state.exiting.load(Ordering::SeqCst) {
                break;
            }
            if !state.responsive.load(Ordering::SeqCst) {
                continue;
            }
            let result = core_action(&keyboard_app, "main", json!({"type":binding.action})).await;
            #[cfg(debug_assertions)]
            if state.diagnostic {
                let snapshots = state.snapshots.lock().unwrap();
                let player = snapshots
                    .get("main")
                    .map(|snapshot| &snapshot.value["player"]);
                let shortcut_state = keyboard_app.state::<ShortcutState>();
                let mut events = shortcut_state.events.lock().unwrap();
                if events.len() < 128 {
                    events.push(json!({"action":binding.action,"result":result,
                        "status":player.map(|p| p["status"].clone()),
                        "queueIndex":player.map(|p| p["currentQueueIndex"].clone()),
                        "bothWindowsHidden":(["main","mini"].iter().all(|surface| !keyboard_app.get_webview_window(surface).unwrap().is_visible().unwrap_or(true)))}));
                    if let Ok(Some(options)) = smoke::options() {
                        let _ = std::fs::write(
                            options.directory.join("hotkey-events.json"),
                            serde_json::to_vec_pretty(&*events).unwrap(),
                        );
                    }
                }
            }
            #[cfg(not(debug_assertions))]
            let _ = result;
        }
    });
}
fn stop_shortcuts(app: &tauri::AppHandle) {
    #[cfg(windows)]
    if let Some(state) = app.try_state::<ShortcutState>() {
        if let Some(mut service) = state.service.lock().unwrap().take() {
            service.stop();
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}
fn show_shortcuts(app: &tauri::AppHandle) {
    #[cfg(windows)]
    let text = app.state::<ShortcutState>().help.clone();
    #[cfg(not(windows))]
    let text = "当前宿主未提供全局快捷键。".to_string();
    app.dialog().message(format!("{text}\n\n窗口隐藏或收到托盘后仍可使用。退出播放器后释放快捷键。\n被占用的组合不会抢占其他程序，可用托盘播放菜单替代。"))
        .title("CD 播放器 · 快捷键").show(|_| {});
}

struct Snapshot {
    value: Value,
    sequence: u64,
}
struct PendingAction {
    sender: oneshot::Sender<Value>,
    name: &'static str,
    started: Instant,
    stage: diagnostics::Stage,
}
struct NativeState {
    origin: String,
    started: Instant,
    child: Mutex<Option<Child>>,
    snapshots: Mutex<HashMap<String, Snapshot>>,
    pending: Mutex<HashMap<String, PendingAction>>,
    logs: diagnostics::Recorder,
    mode: Mutex<String>,
    dirty: Mutex<(u64, HashSet<String>)>,
    ready: Mutex<HashSet<String>>,
    quit_pending: AtomicBool,
    exiting: AtomicBool,
    window_serial: tokio::sync::Mutex<()>,
    diagnostic: bool,
    failures: Mutex<Vec<String>>,
    last_heartbeat_ms: AtomicU64,
    backend_ready: AtomicBool,
    responsive: AtomicBool,
    materials: Mutex<materials::State>,
}
impl Drop for NativeState {
    fn drop(&mut self) {
        if let Some(child) = self.child.get_mut().unwrap().take() {
            shutdown_child(child);
        }
    }
}
fn unavailable() -> Value {
    json!({"ok":false,"code":"unavailable","message":"播放核心未及时响应，请重试。"})
}
fn applied() -> Value {
    json!({"ok":true,"status":"applied"})
}
fn core_is_fresh(now_ms: u64, heartbeat_ms: u64, backend_ready: bool) -> bool {
    backend_ready && now_ms.saturating_sub(heartbeat_ms) < 3000
}
fn check(window: &WebviewWindow, state: &NativeState, core_only: bool) -> Result<(), String> {
    if !matches!(window.label(), "main" | "mini") || (core_only && window.label() != "main") {
        return Err("Window is not authorized".into());
    }
    if window
        .url()
        .map_err(|e| e.to_string())?
        .origin()
        .ascii_serialization()
        != state.origin
    {
        return Err("Origin is not authorized".into());
    }
    Ok(())
}
fn native_host(app: &tauri::AppHandle, surface: &str, source: &Value) -> Value {
    let state = app.state::<NativeState>();
    let window = app.get_webview_window(surface).unwrap();
    let material = state.materials.lock().unwrap().host(surface, &source["settings"], &window);
    json!({"shell":"tauri","windowMode":state.mode.lock().unwrap().clone(),
    "surfaceVisible":window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false),"backdrop":material.backdrop,"alwaysOnTop":window.is_always_on_top().unwrap_or(false),
    "nativeCornerRadius":0,"effectiveReducedMotion":material.reduced_motion,
    "transparencyAllowed":material.transparency_allowed,"coreStatus":if state.responsive.load(Ordering::SeqCst) {"ready"} else {"unresponsive"},
    "capabilities":{"nativeWindows":true,"transparentWindow":true,"windowDragging":true,"alwaysOnTop":true}})
}
fn merge_snapshot(previous: &mut Value, delta: &Value) {
    for (key, value) in delta.as_object().unwrap() {
        if key == "player" && previous["player"].is_object() {
            for (field, content) in value.as_object().unwrap() {
                previous["player"][field] = content.clone();
            }
        } else {
            previous[key] = value.clone();
        }
    }
}
fn refresh_hosts(app: &tauri::AppHandle) -> Result<(), String> {
    let snapshots = {
        let state = app.state::<NativeState>();
        let values = state.snapshots.lock().unwrap();
        values
            .iter()
            .map(|(key, s)| (key.clone(), s.value.clone()))
            .collect::<Vec<_>>()
    };
    for (surface, value) in snapshots {
        let host = native_host(app, &surface, &value);
        let envelope = {
            let state = app.state::<NativeState>();
            let mut values = state.snapshots.lock().unwrap();
            let snapshot = values.get_mut(&surface).unwrap();
            snapshot.value["host"] = host.clone();
            snapshot.sequence += 1;
            json!({"sequence":snapshot.sequence,"snapshot":{"host":host}})
        };
        app.emit_to(surface, "cd-snapshot", envelope)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn clamp_position(
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    ax: i32,
    ay: i32,
    aw: u32,
    ah: u32,
) -> (i32, i32) {
    let right = ax as i64 + aw.saturating_sub(w) as i64;
    let bottom = ay as i64 + ah.saturating_sub(h) as i64;
    (
        (x as i64).clamp(ax as i64, right) as i32,
        (y as i64).clamp(ay as i64, bottom) as i32,
    )
}
fn resize_mini(app: &tauri::AppHandle, snapshot: &Value) -> Result<(), String> {
    let Some(window) = app.get_webview_window("mini") else {
        return Ok(());
    };
    let settings = &snapshot["settings"];
    let height = if settings["miniShowLyrics"] == true
        && snapshot["lyrics"]["kind"] == "synced"
        && snapshot["lyrics"]["trackId"] == snapshot["player"]["currentTrackId"]
    {
        164.0
    } else {
        116.0
    };
    window
        .set_always_on_top(settings["miniAlwaysOnTop"].as_bool().unwrap_or(false))
        .map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let old = window.inner_size().map_err(|e| e.to_string())?;
    let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let area = monitor.work_area();
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let width_px = (384.0 * scale).round().min(area.size.width as f64) as u32;
    let height_px = (height * scale).round().min(area.size.height as f64) as u32;
    let (x, y) = clamp_position(
        position.x,
        position.y,
        width_px,
        height_px,
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
    );
    if old.width != width_px || old.height != height_px {
        window
            .set_size(tauri::PhysicalSize::new(width_px, height_px))
            .map_err(|e| e.to_string())?;
    }
    if position.x != x || position.y != y {
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn switch_window(app: &tauri::AppHandle, mode: &str) -> Result<(), String> {
    switch_window_until(app, mode, None)
}
fn switch_window_until(
    app: &tauri::AppHandle,
    mode: &str,
    deadline: Option<f64>,
) -> Result<(), String> {
    let (target, old) = if mode == "mini" {
        ("mini", "main")
    } else {
        ("main", "mini")
    };
    let state = app.state::<NativeState>();
    if !state.ready.lock().unwrap().contains(target) {
        return Err("目标窗口尚未准备好。".into());
    }
    let window = app.get_webview_window(target).ok_or("Window unavailable")?;
    let was_visible = window.is_visible().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    if !window.is_visible().map_err(|e| e.to_string())? {
        return Err("Target was not shown".into());
    }
    if deadline.is_some_and(|end| state.started.elapsed().as_secs_f64() * 1000.0 >= end) {
        if !was_visible {
            let _ = window.hide();
        }
        return Err("窗口切换请求超时，请重试。".into());
    }
    app.get_webview_window(old)
        .unwrap()
        .hide()
        .map_err(|e| e.to_string())?;
    *state.mode.lock().unwrap() = if mode == "mini" { "mini" } else { "full" }.into();
    if !state.diagnostic {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    refresh_hosts(app)
}
fn hide_windows(app: &tauri::AppHandle) -> Result<(), String> {
    for surface in ["main", "mini"] {
        app.get_webview_window(surface)
            .unwrap()
            .hide()
            .map_err(|e| e.to_string())?;
    }
    refresh_hosts(app)
}
async fn core_action(app: &tauri::AppHandle, surface: &str, action: Value) -> Value {
    let deadline = app.state::<NativeState>().started.elapsed().as_secs_f64() * 1000.0 + 4500.0;
    core_action_until(app, surface, action, deadline).await
}
async fn core_action_until(
    app: &tauri::AppHandle,
    surface: &str,
    action: Value,
    deadline_ms: f64,
) -> Value {
    let remaining =
        deadline_ms - app.state::<NativeState>().started.elapsed().as_secs_f64() * 1000.0;
    if remaining <= 0.0 {
        return unavailable();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    {
        app.state::<NativeState>()
            .pending
            .lock()
            .unwrap()
            .insert(id.clone(), PendingAction { sender: tx, name: diagnostics::action_name(action["type"].as_str().unwrap_or("")),
                started: Instant::now(), stage: diagnostics::Stage::Sent });
    }
    app.state::<NativeState>().logs.action(&id, action["type"].as_str().unwrap_or(""), "action_sent", diagnostics::Stage::Sent, 0, None);
    if app
        .emit_to(
            "main",
            "cd-action",
            json!({"id":id,"surface":surface,"action":action,"deadlineMs":deadline_ms}),
        )
        .is_err()
    {
        let removed = app.state::<NativeState>()
            .pending
            .lock()
            .unwrap()
            .remove(&id);
        if let Some(pending) = removed { app.state::<NativeState>().logs.action(&id,pending.name,"action_emit_failed",pending.stage,pending.started.elapsed().as_millis() as u64,None); }
        return unavailable();
    }
    let result = tokio::time::timeout(Duration::from_secs_f64(remaining / 1000.0), rx)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(unavailable);
    let removed = app.state::<NativeState>()
        .pending
        .lock()
        .unwrap()
        .remove(&id);
    if let Some(pending) = removed { app.state::<NativeState>().logs.action(&id,pending.name,"action_timeout",pending.stage,pending.started.elapsed().as_millis() as u64,None); }
    result
}
#[tauri::command]
async fn surface_name(
    window: WebviewWindow,
    state: tauri::State<'_, NativeState>,
) -> Result<String, String> {
    check(&window, &state, false)?;
    Ok(window.label().into())
}
#[tauri::command]
async fn frontend_error(
    window: WebviewWindow,
    state: tauri::State<'_, NativeState>,
    message: String,
) -> Result<(), String> {
    check(&window, &state, false)?;
    let message = format!(
        "{}: {}",
        window.label(),
        message.chars().take(1000).collect::<String>()
    );
    eprintln!("Frontend initialization: {message}");
    let mut failures = state.failures.lock().unwrap();
    if failures.len() < 50 {
        failures.push(message);
    }
    Ok(())
}
#[tauri::command]
async fn clock_sample(
    window: WebviewWindow,
    state: tauri::State<'_, NativeState>,
) -> Result<f64, String> {
    check(&window, &state, false)?;
    Ok(state.started.elapsed().as_secs_f64() * 1000.0)
}
#[tauri::command]
async fn core_heartbeat(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, NativeState>,
    backend_ready: bool,
) -> Result<(), String> {
    check(&window, &state, true)?;
    state
        .last_heartbeat_ms
        .store(state.started.elapsed().as_millis() as u64, Ordering::SeqCst);
    state.backend_ready.store(backend_ready, Ordering::SeqCst);
    if state.responsive.swap(backend_ready, Ordering::SeqCst) != backend_ready {
        state.logs.health(backend_ready);
        refresh_hosts(&app)?;
    }
    Ok(())
}
#[tauri::command]
async fn request_snapshot(
    window: WebviewWindow,
    state: tauri::State<'_, NativeState>,
) -> Result<Value, String> {
    check(&window, &state, false)?;
    let values = state.snapshots.lock().unwrap();
    let value = values.get(window.label()).ok_or("Core not ready")?;
    Ok(json!({"sequence":value.sequence,"snapshot":value.value,"full":true}))
}
#[tauri::command]
async fn push_snapshot(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, NativeState>,
    surface: String,
    delta: Value,
) -> Result<(), String> {
    check(&window, &state, true)?;
    if !matches!(surface.as_str(), "main" | "mini")
        || !delta.is_object()
        || delta.get("player").is_some_and(|p| !p.is_object())
    {
        return Err("Invalid snapshot".into());
    }
    let value = {
        let values = state.snapshots.lock().unwrap();
        let mut value = values
            .get(&surface)
            .map(|s| s.value.clone())
            .unwrap_or_else(|| json!({}));
        merge_snapshot(&mut value, &delta);
        value
    };
    if value["contractVersion"] != "0.4.0"
        || !value["settings"].is_object()
        || !value["player"].is_object()
    {
        return Err("Incomplete snapshot".into());
    }
    // A playback sample says nothing about whether the local HTTP backend is alive.
    if delta.get("settings").is_some() || delta.get("lyrics").is_some() {
        resize_mini(&app, &value)?;
    }
    let host = native_host(&app, &surface, &value);
    let mut outgoing = delta;
    let envelope = {
        let mut values = state.snapshots.lock().unwrap();
        let snapshot = values.entry(surface.clone()).or_insert(Snapshot {
            value: json!({}),
            sequence: 0,
        });
        merge_snapshot(&mut snapshot.value, &outgoing);
        snapshot.value["host"] = host.clone();
        outgoing["host"] = host;
        snapshot.sequence += 1;
        json!({"sequence":snapshot.sequence,"snapshot":outgoing})
    };
    app.emit_to(surface, "cd-snapshot", envelope)
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn resolve_action(
    window: WebviewWindow,
    state: tauri::State<'_, NativeState>,
    id: String,
    result: Value,
) -> Result<(), String> {
    check(&window, &state, true)?;
    if let Some(pending) = state.pending.lock().unwrap().remove(&id) {
        state.logs.action(&id,pending.name,"action_result",pending.stage,pending.started.elapsed().as_millis() as u64,Some(&result));
        let _ = pending.sender.send(result);
    }
    Ok(())
}
#[tauri::command]
async fn report_action_stage(
    window: WebviewWindow, state: tauri::State<'_, NativeState>, id: String, stage: String,
) -> Result<(), String> {
    check(&window,&state,true)?;
    let stage = diagnostics::Stage::parse(&stage).ok_or("Invalid action stage")?;
    if let Some(pending) = state.pending.lock().unwrap().get_mut(&id) {
        if stage > pending.stage {
            pending.stage=stage;
            state.logs.action(&id,pending.name,"action_stage",stage,pending.started.elapsed().as_millis() as u64,None);
        }
    }
    Ok(())
}
#[tauri::command]
async fn surface_ready(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, NativeState>,
) -> Result<(), String> {
    check(&window, &state, false)?;
    let first = state.ready.lock().unwrap().insert(window.label().into());
    let show = !state.diagnostic;
    #[cfg(debug_assertions)]
    let show = show || smoke::manual();
    if first && window.label() == "main" && show {
        switch_window(&app, "full")?;
    }
    Ok(())
}
#[tauri::command]
async fn dispatch_action(
    app: tauri::AppHandle,
    window: WebviewWindow,
    surface: String,
    action: Value,
    deadline_ms: f64,
) -> Result<Value, String> {
    let state = app.state::<NativeState>();
    check(&window, &state, false)?;
    let now = state.started.elapsed().as_secs_f64() * 1000.0;
    if !deadline_ms.is_finite() || deadline_ms <= now || deadline_ms > now + 5000.0 {
        return Ok(unavailable());
    }
    if surface != window.label() || !action.is_object() {
        return Err("Surface mismatch".into());
    }
    match action["type"].as_str().unwrap_or("") {
        "setWindowMode" => {
            let _serial = state.window_serial.lock().await;
            if state.started.elapsed().as_secs_f64() * 1000.0 >= deadline_ms {
                return Ok(unavailable());
            }
            let mode = action["mode"]
                .as_str()
                .filter(|m| matches!(*m, "full" | "mini"))
                .ok_or("Invalid mode")?;
            Ok(switch_window_until(&app, mode, Some(deadline_ms))
                .map(|_| applied())
                .unwrap_or_else(|e| json!({"ok":false,"code":"unavailable","message":e})))
        }
        "hideToTray" => {
            let _serial = state.window_serial.lock().await;
            if state.started.elapsed().as_secs_f64() * 1000.0 >= deadline_ms {
                return Ok(unavailable());
            }
            hide_windows(&app)?;
            Ok(applied())
        }
        "beginWindowDrag" => {
            if surface != "mini" {
                return Ok(
                    json!({"ok":false,"code":"unsupported","message":"主窗口请使用原生标题栏拖动。"}),
                );
            }
            window.start_dragging().map_err(|e| e.to_string())?;
            Ok(applied())
        }
        "reportUnsavedChanges" => {
            if action["surface"] != surface || !action["dirty"].is_boolean() {
                return Err("Invalid dirty report".into());
            }
            let mut dirty = state.dirty.lock().unwrap();
            let changed = if action["dirty"] == true {
                dirty.1.insert(surface)
            } else {
                dirty.1.remove(&surface)
            };
            if changed {
                dirty.0 += 1;
            }
            Ok(applied())
        }
        _ => Ok(core_action_until(&app, &surface, action, deadline_ms).await),
    }
}
fn request_exit(app: tauri::AppHandle) {
    if app
        .state::<NativeState>()
        .quit_pending
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let (revision, dirty) = {
                let state = app.state::<NativeState>();
                let data = state.dirty.lock().unwrap();
                (data.0, !data.1.is_empty())
            };
            if dirty {
                let dialog_app = app.clone();
                let accepted = tauri::async_runtime::spawn_blocking(move || {
                    dialog_app
                        .dialog()
                        .message("仍有未保存的修改。退出会丢弃这些草稿。是否退出？")
                        .title("CD 播放器")
                        .buttons(MessageDialogButtons::OkCancel)
                        .blocking_show()
                })
                .await
                .unwrap_or(false);
                if !accepted {
                    app.state::<NativeState>()
                        .quit_pending
                        .store(false, Ordering::SeqCst);
                    return;
                }
                if app.state::<NativeState>().dirty.lock().unwrap().0 != revision {
                    continue;
                }
            }
            app.state::<NativeState>()
                .exiting
                .store(true, Ordering::SeqCst);
            stop_shortcuts(&app);
            let close_app = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || stop_backend(&close_app)).await;
            app.exit(0);
            break;
        }
    });
}
fn stop_backend(app: &tauri::AppHandle) {
    let Some(child) = app.state::<NativeState>().child.lock().unwrap().take() else {
        return;
    };
    app.state::<NativeState>().logs.lifecycle("stopping");
    shutdown_child(child);
    app.state::<NativeState>().logs.lifecycle("stopped");
    app.state::<NativeState>().logs.finish();
}
fn shutdown_child(mut child: Child) {
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(b"shutdown\n");
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}
fn launch_backend(
    runtime: PathBuf,
    assets: PathBuf,
    directory: PathBuf,
) -> Result<(Child, String), Box<dyn std::error::Error>> {
    // Node's module resolver does not accept Windows extended-length path prefixes.
    let runtime = dunce::simplified(&runtime).to_path_buf();
    let assets = dunce::simplified(&assets).to_path_buf();
    let directory = dunce::simplified(&directory).to_path_buf();
    let mut command = Command::new(runtime.join("node.exe"));
    command
        .arg(runtime.join("server.mjs"))
        .arg("--data")
        .arg(directory)
        .arg("--assets")
        .arg(assets)
        .arg("--picker")
        .arg(runtime.join("file-picker.exe"));
    #[cfg(windows)]
    command.arg("--recover-stale-lock");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let output = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        let mut line = String::new();
        let result = reader.read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
    });
    let result = (|| {
        let line = rx.recv_timeout(Duration::from_secs(15))??;
        let response: Value = serde_json::from_str(&line)?;
        if let Some(message) = response["startupError"]["message"].as_str() {
            return Err(message.to_string().into());
        }
        let origin = response["origin"]
            .as_str()
            .ok_or("Backend did not report origin")?
            .to_string();
        let url: tauri::Url = origin.parse()?;
        if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
            return Err("Invalid backend origin".into());
        }
        Ok(origin)
    })();
    match result {
        Ok(origin) => Ok((child, origin)),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}
fn main() {
    let application = tauri::Builder::default().plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![surface_name,clock_sample,core_heartbeat,request_snapshot,push_snapshot,resolve_action,report_action_stage,surface_ready,dispatch_action,frontend_error])
    .setup(|app| {
      let resources = app.path().resource_dir()?;
      let (runtime,assets) = if resources.join("runtime/node.exe").is_file() {
        (resources.join("runtime"),resources.join("web"))
      } else {
        // Compile the source checkout fallback only into development builds.
        #[cfg(debug_assertions)] {
          let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
          (source.join(".native-runtime"),source.join("dist"))
        }
        #[cfg(not(debug_assertions))] {
          return Err("Desktop runtime files are missing".into());
        }
      };
      let directory = app.path().app_data_dir()?;
      #[cfg(debug_assertions)] let (directory,diagnostic) = match smoke::options()? { Some(options) => (options.directory,true), None => (directory,false) };
      #[cfg(not(debug_assertions))] let diagnostic = false;
      app.manage(startup::acquire_instance(&directory)?);
      let (child,origin) = launch_backend(runtime,assets,directory.clone())?;
      let logs=diagnostics::Recorder::new(&directory); logs.lifecycle("started");
      app.manage(NativeState { origin:origin.clone(),started:Instant::now(),child:Mutex::new(Some(child)),snapshots:Mutex::new(HashMap::new()),pending:Mutex::new(HashMap::new()),logs,mode:Mutex::new("full".into()),dirty:Mutex::new((0,HashSet::new())),ready:Mutex::new(HashSet::new()),quit_pending:AtomicBool::new(false),exiting:AtomicBool::new(false),window_serial:tokio::sync::Mutex::new(()),diagnostic,failures:Mutex::new(Vec::new()),last_heartbeat_ms:AtomicU64::new(0),backend_ready:AtomicBool::new(false),responsive:AtomicBool::new(false),materials:Mutex::new(materials::State::new()) });
      app.add_capability(tauri::ipc::CapabilityBuilder::new("owned-loopback-events").windows(["main","mini"]).local(false).remote(format!("{origin}/*")).permission("core:event:allow-listen").permission("core:event:allow-unlisten"))?;
      app.add_capability(tauri::ipc::CapabilityBuilder::new("owned-loopback-ui").windows(["main","mini"]).local(false).remote(format!("{origin}/*"))
        .permission("allow-surface-name").permission("allow-clock-sample").permission("allow-request-snapshot")
        .permission("allow-surface-ready").permission("allow-dispatch-action").permission("allow-frontend-error"))?;
      app.add_capability(tauri::ipc::CapabilityBuilder::new("owned-loopback-core").window("main").local(false).remote(format!("{origin}/*"))
        .permission("allow-push-snapshot").permission("allow-resolve-action").permission("allow-report-action-stage").permission("allow-core-heartbeat"))?;
      for surface in ["main","mini"] {
        let url = format!("{origin}/desktop.html").parse()?; let allowed = origin.clone();
            let mut builder = WebviewWindowBuilder::new(app,surface,WebviewUrl::External(url)).title(if diagnostic {"CD 播放器（隔离测试）"} else {"CD 播放器"}).visible(false).disable_drag_drop_handler()
          .on_navigation(move |url| url.origin().ascii_serialization() == allowed).on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny)
          .on_page_load(|window,payload| { if window.app_handle().state::<NativeState>().diagnostic { eprintln!("{} navigation {:?}: {}",window.label(),payload.event(),payload.url()); } })
          .additional_browser_args("--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding");
        // Diagnostic runs must not share the live user's WebView2 profile.
        #[cfg(debug_assertions)] if diagnostic { builder = builder.data_directory(directory.join("webview-test")); }
        if surface == "main" { builder = builder.inner_size(1280.0,800.0).min_inner_size(960.0,600.0).transparent(true).background_color(tauri::window::Color(0,0,0,0)); }
        else { builder = builder.inner_size(384.0,116.0).decorations(false).transparent(true).shadow(false).resizable(false).skip_taskbar(true).background_color(tauri::window::Color(0,0,0,0)); }
        #[cfg(debug_assertions)] if diagnostic && smoke::stream_only() {
            builder = builder.initialization_script("window.__CD_STREAM_AUDIO_TEST__=true;");
        }
        #[cfg(debug_assertions)] if diagnostic && smoke::recovery() {
            builder = builder.initialization_script("window.AudioContext=new Proxy(window.AudioContext,{construct(T,args){const c=Reflect.construct(T,args);window.__CD_OUTPUT_TEST_CONTEXT__=c;return c;}});");
        }
        let window = builder.initialization_script("window.addEventListener('error',e=>{window.__TAURI_INTERNALS__?.invoke('frontend_error',{message:e.message||'resource failed: '+e.target?.src}).catch(()=>{});},true);").build()?; let handle = app.handle().clone();
        window.on_window_event(move |event| { if let tauri::WindowEvent::CloseRequested { api,.. } = event { if !handle.state::<NativeState>().exiting.load(Ordering::SeqCst) { api.prevent_close(); let _ = hide_windows(&handle); } } });
      }
      #[cfg(windows)] {
        #[cfg(debug_assertions)] let enable_shortcuts = !diagnostic || smoke::hotkeys();
        #[cfg(not(debug_assertions))] let enable_shortcuts = true;
        install_shortcuts(app.handle(),enable_shortcuts);
      }
      let menu = tauri::menu::Menu::with_items(app,&[
        &tauri::menu::MenuItem::with_id(app,"main","显示主窗口",true,None::<&str>)?, &tauri::menu::MenuItem::with_id(app,"mini","显示迷你播放器",true,None::<&str>)?,
        &tauri::menu::MenuItem::with_id(app,"play","播放 / 暂停",true,None::<&str>)?, &tauri::menu::MenuItem::with_id(app,"previous","上一首",true,None::<&str>)?, &tauri::menu::MenuItem::with_id(app,"next","下一首",true,None::<&str>)?,
        &tauri::menu::MenuItem::with_id(app,"shortcuts","快捷键说明",true,None::<&str>)?, &tauri::menu::MenuItem::with_id(app,"exit","退出",true,None::<&str>)? ])?;
      let tray_icon = app.default_window_icon().cloned()
        .ok_or_else(|| std::io::Error::other("The embedded application icon is missing"))?;
      tauri::tray::TrayIconBuilder::with_id("player-tray").icon(tray_icon).tooltip("CD 播放器").menu(&menu).show_menu_on_left_click(false)
        .on_menu_event(|app,event| match event.id.as_ref() {
          "main" => { let _ = switch_window(app,"full"); }, "mini" => { let _ = switch_window(app,"mini"); },
          "play"|"previous"|"next" => { let app = app.clone(); let action = match event.id.as_ref() { "play"=>"togglePlayback", "previous"=>"previous", _=>"next" }; tauri::async_runtime::spawn(async move { let _ = core_action(&app,"main",json!({"type":action})).await; }); },
          "shortcuts" => show_shortcuts(app),
          "exit" => request_exit(app.clone()), _ => {} })
        .on_tray_icon_event(|tray,event| { if let tauri::tray::TrayIconEvent::Click { button:tauri::tray::MouseButton::Left,button_state:tauri::tray::MouseButtonState::Up,.. } = event { let _ = switch_window(tray.app_handle(),"full"); } }).build(app)?;
      let health_app=app.handle().clone();
      tauri::async_runtime::spawn(async move { let mut material_tick = 0; loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let state=health_app.state::<NativeState>();
        if state.exiting.load(Ordering::SeqCst) {break;}
        let fresh=core_is_fresh(state.started.elapsed().as_millis() as u64,state.last_heartbeat_ms.load(Ordering::SeqCst),state.backend_ready.load(Ordering::SeqCst));
        material_tick += 1;
        let material_changed = material_tick % 4 == 0 && state.materials.lock().unwrap().refresh();
        let health_changed=state.responsive.swap(fresh,Ordering::SeqCst)!=fresh;
        if health_changed {state.logs.health(fresh);}
        if health_changed || material_changed {let _=refresh_hosts(&health_app);}
      }});
      #[cfg(debug_assertions)] if diagnostic { smoke::start(app.handle().clone()); }
      Ok(())
    }).build(tauri::generate_context!()).unwrap_or_else(|error| {
        startup::report_error(&error.to_string());
        std::process::exit(1);
    });
    application.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            stop_shortcuts(app);
        }
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<NativeState>().exiting.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_exit(app.clone());
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_health_depends_on_heartbeat_instead_of_audio_samples() {
        assert!(core_is_fresh(60000, 59500, true));
        assert!(core_is_fresh(60000, 57001, true));
        assert!(!core_is_fresh(60000, 57000, true));
    }
    #[test]
    fn a_failed_backend_probe_stays_unavailable_even_with_fresh_renderer_activity() {
        assert!(!core_is_fresh(60000, 60000, false));
        assert!(!core_is_fresh(0, 0, false));
    }
    #[test]
    fn delta_merge_keeps_nested_queue() {
        let mut old =
            json!({"player":{"queue":[{"id":"q"}],"positionMs":0},"lyrics":{"revision":2}});
        merge_snapshot(&mut old, &json!({"player":{"positionMs":500}}));
        assert_eq!(old["player"]["queue"][0]["id"], "q");
        assert_eq!(old["lyrics"]["revision"], 2);
        assert_eq!(old["player"]["positionMs"], 500);
    }
    #[test]
    fn bottom_growth_clamps_upward_on_negative_monitor() {
        assert_eq!(
            clamp_position(-20, 900, 384, 164, -1920, 0, 1920, 1000),
            (-384, 836)
        );
        assert_eq!(clamp_position(200, 200, 384, 164, 0, 0, 100, 80), (0, 0));
    }
}
