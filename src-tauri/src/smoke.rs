// Opt-in developer integration check. Compiled out of release executables.
use super::*;
pub struct Options {
    pub directory: PathBuf,
    report: PathBuf,
}
pub fn manual() -> bool {
    std::env::args().any(|arg| arg == "--smoke-manual")
}
pub fn hotkeys() -> bool {
    manual() && std::env::args().any(|arg| arg == "--smoke-hotkeys")
}
pub fn audio() -> bool {
    std::env::args().any(|arg| arg == "--smoke-audio")
}
pub fn long_compressed() -> bool {
    std::env::args().any(|arg| arg == "--smoke-long-compressed")
}
pub fn recovery() -> bool {
    std::env::args().any(|arg| arg == "--smoke-recovery")
}
pub fn continuous() -> bool {
    std::env::args().any(|arg| arg == "--smoke-continuous")
}
pub fn background() -> bool {
    std::env::args().any(|arg| arg == "--smoke-background")
}
fn soak_seconds(args: &[String]) -> Result<Option<u64>, String> {
    let positions = args.iter().enumerate().filter(|(_, v)| *v == "--smoke-soak-seconds")
        .map(|(i, _)| i).collect::<Vec<_>>();
    if positions.is_empty() { return Ok(None); }
    if positions.len() != 1 || !args.iter().any(|v| v == "--smoke-background") {
        return Err("Soak duration requires one --smoke-background duration".into());
    }
    let seconds = args.get(positions[0] + 1).and_then(|s| s.parse::<u64>().ok())
        .filter(|s| (60..=86400).contains(s)).ok_or("Soak seconds must be 60..86400")?;
    Ok(Some(seconds))
}
pub fn materials() -> bool {
    std::env::args().any(|arg| arg == "--smoke-materials")
}
pub fn stream_only() -> bool {
    std::env::args().any(|arg| arg == "--smoke-stream-only")
}
pub fn options() -> Result<Option<Options>, Box<dyn std::error::Error>> {
    let args = std::env::args().collect::<Vec<_>>();
    soak_seconds(&args)?;
    let value = |key| {
        args.iter()
            .position(|v| v == key)
            .and_then(|i| args.get(i + 1))
            .map(PathBuf::from)
    };
    let Some(directory) = value("--smoke-data") else {
        return Ok(None);
    };
    let report = value("--smoke-report").ok_or("Smoke report path required")?;
    if !directory.is_absolute() || !report.is_absolute() {
        return Err("Smoke paths must be absolute".into());
    }
    Ok(Some(Options { directory, report }))
}
async fn wait_until(
    app: &tauri::AppHandle,
    predicate: impl Fn(&NativeState) -> bool,
) -> Result<(), String> {
    let end = Instant::now() + Duration::from_secs(20);
    while Instant::now() < end {
        if predicate(&app.state::<NativeState>()) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("Desktop check timed out".into())
}
async fn run(app: &tauri::AppHandle) -> Result<Value, String> {
    wait_until(app, |state| state.ready.lock().unwrap().len() == 2).await?;
    let main = app.get_webview_window("main").unwrap();
    let mini = app.get_webview_window("mini").unwrap();
    let mut checks = Vec::new();
    checks.push(json!({"name":"WebView2 main and mini initialized","passed":true}));
    // Idle players publish no audio samples. Health must remain independent of playback.
    hide_windows(app)?;
    tokio::time::sleep(Duration::from_millis(3500)).await;
    {
        let state = app.state::<NativeState>();
        let snapshots = state.snapshots.lock().unwrap();
        if !state.responsive.load(Ordering::SeqCst)
            || snapshots["main"].value["host"]["coreStatus"] != "ready"
            || snapshots["mini"].value["host"]["coreStatus"] != "ready"
        {
            return Err(
                "Idle player with no selected track was falsely marked unresponsive".into(),
            );
        }
    }
    checks.push(json!({"name":"Idle player stays connected after both windows are hidden beyond watchdog timeout","passed":true}));
    switch_window(app, "mini")?;
    if main.is_visible().unwrap() || !mini.is_visible().unwrap() {
        return Err("Native mini switch failed".into());
    }
    checks.push(json!({"name":"Native show target before hiding main","passed":true}));
    let native_now = app.state::<NativeState>().started.elapsed().as_secs_f64() * 1000.0;
    let expired = dispatch_action(
        app.clone(),
        mini.clone(),
        "mini".into(),
        json!({"type":"setWindowMode","mode":"full"}),
        native_now - 1.0,
    )
    .await?;
    if expired["ok"] != false || main.is_visible().unwrap() || !mini.is_visible().unwrap() {
        return Err("Expired window request was committed".into());
    }
    let forged = dispatch_action(
        app.clone(),
        mini.clone(),
        "main".into(),
        json!({"type":"reportUnsavedChanges","surface":"main","dirty":true}),
        native_now + 4000.0,
    )
    .await;
    if forged.is_ok() {
        return Err("Surface identity spoof was accepted".into());
    }
    checks.push(
        json!({"name":"Expired IPC work and forged surface identities rejected","passed":true}),
    );
    if app.tray_by_id("player-tray").is_none() {
        return Err("Native tray was not created".into());
    }
    checks.push(json!({"name":"Native tray icon and menu constructed","passed":true}));
    let revision = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["library"]
        ["revision"]
        .as_u64()
        .ok_or("Missing library revision")?;
    let rescan = core_action(app, "main", json!({"type":"rescanLibrary"})).await;
    if rescan["ok"] != true || rescan["status"] != "started" {
        return Err(format!("Bundled rescan did not start: {rescan}"));
    }
    wait_until(app, |state| {
        let snapshots = state.snapshots.lock().unwrap();
        let value = &snapshots["main"].value;
        value["library"]["revision"].as_u64().unwrap_or(0) > revision
            && value["tasks"]
                .as_array()
                .is_some_and(|tasks| tasks.is_empty())
    })
    .await?;
    checks.push(json!({"name":"Bundled production metadata scanner and authenticated task transport","passed":true}));
    let track = {
        let state = app.state::<NativeState>();
        let values = state.snapshots.lock().unwrap();
        values["main"].value["library"]["tracks"][0]["id"]
            .as_str()
            .ok_or("Audio fixture missing")?
            .to_string()
    };
    let played = core_action(
        app,
        "mini",
        json!({"type":"playTracks","trackIds":[track],"startIndex":0}),
    )
    .await;
    if played["ok"] != true {
        return Err(format!("Native audio play: {played}"));
    }
    wait_until(app, |state| {
        state.snapshots.lock().unwrap()["mini"].value["player"]["positionMs"]
            .as_f64()
            .unwrap_or(0.0)
            > 250.0
    })
    .await?;
    hide_windows(app)?;
    let before = {
        app.state::<NativeState>().snapshots.lock().unwrap()["mini"].value["player"]["positionMs"]
            .as_f64()
            .unwrap()
    };
    tokio::time::sleep(Duration::from_millis(750)).await;
    let after = {
        app.state::<NativeState>().snapshots.lock().unwrap()["mini"].value["player"]["positionMs"]
            .as_f64()
            .unwrap()
    };
    if after <= before || main.is_visible().unwrap() || mini.is_visible().unwrap() {
        return Err("Hidden audio did not continue".into());
    }
    checks.push(json!({"name":"Audio clock continues with both native windows hidden","passed":true,"beforeMs":before,"afterMs":after}));
    let result = core_action(app, "mini", json!({"type":"seek","positionMs":2000})).await;
    if result["ok"] != true {
        return Err(format!("Native seek: {result}"));
    }
    let paused = core_action(app, "mini", json!({"type":"togglePlayback"})).await;
    if paused["ok"] != true {
        return Err("Native pause failed".into());
    }
    checks.push(json!({"name":"Mini transport dispatches seek and pause to the sole main audio engine","passed":true}));
    let opened = core_action(
        app,
        "main",
        json!({"type":"openLyricsEditor","trackId":track}),
    )
    .await;
    if opened["ok"] != true {
        return Err(format!("Native editor open: {opened}"));
    }
    let document = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value
        ["lyricsEditor"]["document"]
        .clone();
    let lyric_revision = document["revision"].as_u64().ok_or("No editor revision")?;
    let mut lines = document["lines"].clone();
    lines[0]["original"] = json!("R2 native saved lyric");
    let saved = core_action(app, "main", json!({"type":"saveLyrics","trackId":track,"baseRevision":lyric_revision,
        "patch":{"kind":document["kind"],"language":document["language"],"translationLanguage":document["translationLanguage"],
        "lines":lines,"offsetMs":document["offsetMs"],"locked":true}})).await;
    let changed = core_action(app, "mini", json!({"type":"setLyricsOffset","trackId":track,"baseRevision":lyric_revision+1,"offsetMs":-240})).await;
    let stale = core_action(app, "main", json!({"type":"setLyricsOffset","trackId":track,"baseRevision":lyric_revision,"offsetMs":999})).await;
    let latest = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["lyricsEditor"]
        ["document"]
        .clone();
    if saved["ok"] != true
        || changed["ok"] != true
        || stale["code"] != "conflict"
        || latest["revision"] != lyric_revision + 2
        || latest["offsetMs"] != -240
        || latest["lines"][0]["original"] != "R2 native saved lyric"
    {
        return Err(format!(
            "Native editor save / other writer / conflict: {saved} {changed} {stale} {latest}"
        ));
    }
    checks.push(json!({"name":"Lyrics save and cross-surface writes publish current editor before conflict returns","passed":true}));
    let album = {
        let state = app.state::<NativeState>();
        let values = state.snapshots.lock().unwrap();
        values["main"].value["library"]["albums"][0].clone()
    };
    let album_id = album["id"].as_str().ok_or("No album id")?;
    let album_revision = album["revision"].as_u64().ok_or("No album revision")?;
    let external = core_action(app, "mini", json!({"type":"updateAlbum","albumId":album_id,"baseRevision":album_revision,"patch":{"title":"R2 external album"}})).await;
    let conflict = core_action(app, "main", json!({"type":"updateAlbum","albumId":album_id,"baseRevision":album_revision,"patch":{"catalogNumber":"R2-LOCAL"}})).await;
    let latest_album = {
        let state = app.state::<NativeState>();
        let values = state.snapshots.lock().unwrap();
        values["main"].value["library"]["albums"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == album_id)
            .unwrap()
            .clone()
    };
    if external["ok"] != true
        || conflict["code"] != "conflict"
        || latest_album["revision"] != album_revision + 1
        || latest_album["title"] != "R2 external album"
    {
        return Err(format!(
            "Native metadata snapshot must precede conflict: {external} {conflict} {latest_album}"
        ));
    }
    let merged = core_action(app, "main", json!({"type":"updateAlbum","albumId":album_id,"baseRevision":album_revision+1,"patch":{"catalogNumber":"R2-LOCAL"}})).await;
    if merged["ok"] != true {
        return Err(format!("Native field-only overwrite: {merged}"));
    }
    checks.push(json!({"name":"Latest metadata published before conflict and field-only resubmission","passed":true}));
    let enqueued = core_action(
        app,
        "mini",
        json!({"type":"enqueue","trackIds":[track,track],"position":"end"}),
    )
    .await;
    let before_queue =
        app.state::<NativeState>().snapshots.lock().unwrap()["mini"].value["player"].clone();
    let current_entry = before_queue["currentEntryId"].clone();
    let moved = core_action(
        app,
        "mini",
        json!({"type":"moveQueueEntry","entryId":current_entry,"toIndex":2}),
    )
    .await;
    let after_queue =
        app.state::<NativeState>().snapshots.lock().unwrap()["mini"].value["player"].clone();
    if enqueued["ok"] != true
        || moved["ok"] != true
        || after_queue["currentEntryId"] != current_entry
        || after_queue["currentQueueIndex"] != 2
        || after_queue["positionMs"] != before_queue["positionMs"]
        || after_queue["status"] != "paused"
        || after_queue["queue"][0]["id"] == current_entry
    {
        return Err(format!(
            "Native duplicate queue reorder restarted audio: {before_queue} {after_queue}"
        ));
    }
    checks.push(json!({"name":"Duplicate queue entries reorder by entry id without restarting audio","passed":true}));
    let settings = core_action(
        app,
        "main",
        json!({"type":"updateSettings","patch":{"miniShowLyrics":true,"miniAlwaysOnTop":true}}),
    )
    .await;
    if settings["ok"] != true {
        return Err(format!("Native settings: {settings}"));
    }
    wait_until(app, |state| {
        state.snapshots.lock().unwrap()["mini"].value["settings"]["miniShowLyrics"] == true
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    let size = mini.inner_size().map_err(|e| e.to_string())?;
    let scale = mini.scale_factor().map_err(|e| e.to_string())?;
    if (size.height as f64 / scale - 164.0).abs() > 1.0 || !mini.is_always_on_top().unwrap() {
        return Err("Native mini sizing / topmost failed".into());
    }
    checks.push(json!({"name":"Synced mini lyric height and real topmost","passed":true,"clientHeightDip":size.height as f64/scale}));
    switch_window(app, "full")?;
    if !main.is_visible().unwrap() || mini.is_visible().unwrap() {
        return Err("Native restore failed".into());
    }
    hide_windows(app)?;
    let age = {
        let state = app.state::<NativeState>();
        let snapshots = state.snapshots.lock().unwrap();
        state.started.elapsed().as_secs_f64() * 1000.0
            - snapshots["mini"].value["player"]["positionSampledAt"]
                .as_f64()
                .ok_or("No sampled native time")?
    };
    if !(0.0..750.0).contains(&age) {
        return Err(format!("Native clock alignment age: {age}"));
    }
    checks.push(json!({"name":"Playback samples aligned to host monotonic clock","passed":true,"ageMs":age}));
    let library_revision = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["library"]["revision"]
        .as_u64().ok_or("Missing collection revision")?;
    let stale_removal = core_action(app, "mini", json!({"type":"removeAlbum","albumId":album_id,
        "baseLibraryRevision":library_revision-1})).await;
    if stale_removal["code"] != "conflict" {
        return Err(format!("Stale collection confirmation accepted: {stale_removal}"));
    }
    checks.push(json!({"name":"Collection removal rejects a stale confirmation through native IPC","passed":true}));
    let removal = core_action(app, "mini", json!({"type":"removeAlbum","albumId":album_id,
        "baseLibraryRevision":library_revision})).await;
    if removal["ok"] != true { return Err(format!("Native collection removal failed: {removal}")); }
    {
        let state = app.state::<NativeState>();
        let values = state.snapshots.lock().unwrap();
        for surface in ["main", "mini"] {
            let value = &values[surface].value;
            if value["library"]["revision"] != library_revision + 1
                || value["library"]["albums"].as_array().unwrap().iter().any(|album| album["id"] == album_id)
                || !value["player"]["currentTrackId"].is_null()
                || value["player"]["status"] != "idle"
                || !value["lyrics"].is_null() || !value["lyricsEditor"].is_null()
                || value["player"]["queue"].as_array().unwrap().iter().any(|entry| entry["trackId"] == track) {
                return Err(format!("Removal snapshot not atomic on {surface}: {value}"));
            }
        }
    }
    checks.push(json!({"name":"Native collection removal clears current audio, lyrics, editor and repeated queue entries on both surfaces","passed":true}));
    let rescan = core_action(app, "main", json!({"type":"rescanLibrary"})).await;
    if rescan["status"] != "started" { return Err(format!("Native exclusion rescan failed: {rescan}")); }
    wait_until(app, |state| state.snapshots.lock().unwrap()["main"].value["library"]["revision"]
        .as_u64().is_some_and(|revision| revision > library_revision + 1)).await?;
    if app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["library"]["albums"]
        .as_array().unwrap().iter().any(|album| album["id"] == album_id) {
        return Err("Native rescan restored a removed album".into());
    }
    checks.push(json!({"name":"Native rescan keeps the removed album excluded","passed":true}));
    // A responsive renderer may keep publishing paused samples after HTTP service loss.
    // Those samples must not clear the disconnected state.
    let close_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || stop_backend(&close_app))
        .await
        .map_err(|e| e.to_string())?;
    wait_until(app, |state| {
        !state.responsive.load(Ordering::SeqCst)
            && state.snapshots.lock().unwrap()["main"].value["host"]["coreStatus"] == "unresponsive"
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(750)).await;
    let state = app.state::<NativeState>();
    let snapshots = state.snapshots.lock().unwrap();
    if state.responsive.load(Ordering::SeqCst)
        || snapshots["mini"].value["host"]["coreStatus"] != "unresponsive"
    {
        return Err("Playback samples hid backend failure".into());
    }
    checks.push(json!({"name":"Backend loss stays unavailable despite continuing paused playback samples","passed":true}));
    Ok(
        json!({"passed":true,"checks":checks,"host":snapshots["mini"].value["host"],"player":snapshots["mini"].value["player"],"nativeClockMs":state.started.elapsed().as_secs_f64()*1000.0}),
    )
}
async fn prepare_manual_hotkeys(app: &tauri::AppHandle) -> Result<(), String> {
    wait_until(app, |state| {
        state.ready.lock().unwrap().len() == 2 && state.responsive.load(Ordering::SeqCst)
    })
    .await?;
    let tracks = {
        let state = app.state::<NativeState>();
        let values = state.snapshots.lock().unwrap();
        values["main"].value["library"]["tracks"]
            .as_array()
            .ok_or("Missing hotkey fixture library")?
            .iter()
            .take(2)
            .map(|track| track["id"].clone())
            .collect::<Vec<_>>()
    };
    if tracks.len() != 2 {
        return Err("Hotkey check needs two fixture tracks".into());
    }
    #[cfg(windows)]
    {
        let shortcuts = app.state::<ShortcutState>();
        let service = shortcuts.service.lock().unwrap();
        if !service
            .as_ref()
            .is_some_and(|service| service.registrations.iter().all(|r| r.error.is_none()))
        {
            return Err(format!(
                "Hotkey check could not register every chord: {}",
                shortcuts.help
            ));
        }
    }
    for action in [
        json!({"type":"setMuted","muted":true}),
        json!({"type":"playTracks","trackIds":tracks,"startIndex":1}),
        json!({"type":"togglePlayback"}),
        json!({"type":"seek","positionMs":0}),
    ] {
        let result = core_action(app, "main", action).await;
        if result["ok"] != true {
            return Err(format!("Hotkey fixture preparation failed: {result}"));
        }
    }
    hide_windows(app)?;
    let options = options().unwrap().unwrap();
    std::fs::write(options.directory.join("hotkey-ready.json"),serde_json::to_vec_pretty(&json!({"ready":true,"initialQueueIndex":1,"initialStatus":"paused","muted":true,"bothWindowsHidden":true})).unwrap()).map_err(|e|e.to_string())?;
    Ok(())
}
async fn run_audio(app: &tauri::AppHandle) -> Result<Value, String> {
    wait_until(app, |state| state.ready.lock().unwrap().len() == 2
        && state.responsive.load(Ordering::SeqCst)).await?;
    let tracks = {
        let state = app.state::<NativeState>();
        let values = state.snapshots.lock().unwrap();
        values["main"].value["library"]["tracks"].as_array()
            .ok_or("Missing audio fixtures")?.clone()
    };
    let by_title = |title: &str| -> Result<Value, String> {
        tracks.iter().find(|track| track["title"] == title).cloned()
            .ok_or_else(|| format!("Missing audio fixture {title}"))
    };
    let compressed = long_compressed();
    let long = by_title(if compressed { "01 Long FLAC" } else { "01 Long WAV" })?;
    let hires = by_title(if compressed { "02 Long MP3" } else { "02 HiRes WAV" })?;
    let flac = by_title("窓の光")?;
    let mp3 = by_title("01 Mp3")?;
    let action = |value| core_action(app, "main", value);
    if action(json!({"type":"setMuted","muted":true})).await["ok"] != true {
        return Err("Cannot mute audio check".into());
    }
    let mut checks = Vec::new();
    for (track, successor, position) in [(&long, &flac, 200000.0), (&hires, &mp3, if compressed { 480000.0 } else { 60000.0 })] {
        let started = Instant::now();
        let played = action(json!({"type":"playTracks","trackIds":[track["id"],successor["id"]],"startIndex":0})).await;
        if played["ok"] != true { return Err(format!("Large track play failed: {played}")); }
        wait_until(app, |state| {
            let values = state.snapshots.lock().unwrap();
            values["main"].value["player"]["status"] == "playing"
                && values["main"].value["player"]["positionMs"].as_f64().unwrap_or(0.0) > 250.0
        }).await?;
        let startup_ms = started.elapsed().as_secs_f64() * 1000.0;
        hide_windows(app)?;
        let before = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["player"]["positionMs"].as_f64().unwrap();
        tokio::time::sleep(Duration::from_millis(750)).await;
        let after = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["player"]["positionMs"].as_f64().unwrap();
        if after <= before { return Err("Hidden streamed audio clock stopped".into()); }
        checks.push(json!({"name":"Long track starts and its clock advances with both WebView2 windows hidden",
            "passed":true,"title":track["title"],"durationMs":track["durationMs"],"startupMs":startup_ms,
            "beforeMs":before,"afterMs":after}));
        for value in [json!({"type":"seek","positionMs":position}), json!({"type":"togglePlayback"})] {
            let result = action(value).await;
            if result["ok"] != true { return Err(format!("Streamed seek/pause failed: {result}")); }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let paused = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["player"].clone();
        if paused["status"] != "paused" || paused["positionMs"].as_f64().unwrap_or(0.0) < position - 50.0 {
            return Err(format!("Streamed pause did not retain the actual seek position: {paused}"));
        }
        let resumed = action(json!({"type":"togglePlayback"})).await;
        if resumed["ok"] != true { return Err(format!("Streamed resume failed: {resumed}")); }
        wait_until(app, |state| state.snapshots.lock().unwrap()["main"].value["player"]["positionMs"].as_f64().unwrap_or(0.0) > position + 100.0).await?;
        checks.push(json!({"name":"Long track seek, pause and resume preserve audio position","passed":true,"title":track["title"]}));
        if compressed {
            let end = track["durationMs"].as_f64().ok_or("Missing long fixture duration")?;
            // Exercise indexed/estimated compressed seeking in both directions, including
            // pause while a seek is outstanding. This stays in the real WebView2 decoder.
            for (fraction, pause) in [(0.9, false), (0.1, true), (0.6, false)] {
                let target = end * fraction;
                let sought = action(json!({"type":"seek","positionMs":target})).await;
                if sought["ok"] != true { return Err(format!("Compressed seek failed: {sought}")); }
                if pause {
                    if action(json!({"type":"togglePlayback"})).await["ok"] != true { return Err("Cannot pause compressed seek".into()); }
                    tokio::time::sleep(Duration::from_millis(350)).await;
                    let paused = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["player"].clone();
                    if paused["status"] != "paused" || (paused["positionMs"].as_f64().unwrap_or(-1.0) - target).abs() > 500.0 {
                        return Err(format!("Compressed paused seek drifted: {paused}"));
                    }
                    if action(json!({"type":"togglePlayback"})).await["ok"] != true { return Err("Cannot resume compressed seek".into()); }
                }
                wait_until(app, |state| {
                    let values = state.snapshots.lock().unwrap();
                    let player = &values["main"].value["player"];
                    let actual = player["positionMs"].as_f64().unwrap_or(-1.0);
                    player["status"] == "playing" && player["currentTrackId"] == track["id"]
                        && actual > target + 100.0 && actual < target + 3000.0
                }).await?;
                checks.push(json!({"name":"Long compressed forward/backward seek resumes at the requested region",
                    "passed":true,"title":track["title"],"targetMs":target,"pausedDuringSeek":pause}));
            }
            let before = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["player"]["positionMs"].as_f64().unwrap();
            tokio::time::sleep(Duration::from_secs(12)).await;
            let state = app.state::<NativeState>();
            let value = state.snapshots.lock().unwrap()["main"].value.clone();
            let after = value["player"]["positionMs"].as_f64().unwrap_or(-1.0);
            if value["player"]["status"] != "playing" || after - before < 10000.0 || after - before > 14000.0
                || !state.responsive.load(Ordering::SeqCst) {
                return Err(format!("Long compressed hidden playback stalled: {value}"));
            }
            checks.push(json!({"name":"Long compressed clock remains stable during a hidden playback interval",
                "passed":true,"title":track["title"],"beforeMs":before,"afterMs":after,"intervalMs":12000}));
        }
        let end = track["durationMs"].as_f64().ok_or("Missing fixture duration")?;
        let sought = action(json!({"type":"seek","positionMs":end-400.0})).await;
        if sought["ok"] != true { return Err(format!("Seek near stream end failed: {sought}")); }
        wait_until(app, |state| {
            let values = state.snapshots.lock().unwrap();
            let value = &values["main"].value;
            value["player"]["currentTrackId"] == successor["id"] && value["player"]["status"] == "playing"
                && value["player"]["positionMs"].as_f64().unwrap_or(0.0) > 100.0
                && value["lyrics"]["trackId"] == successor["id"]
        }).await?;
        checks.push(json!({"name":"Stream end automatically switches to the successor with matching lyrics",
            "passed":true,"from":track["title"],"to":successor["title"],"sampleAccurateGaplessClaimed":false,
            "successorUsesStreaming":stream_only()}));
    }
    if action(json!({"type":"togglePlayback"})).await["ok"] != true {
        return Err("Cannot finish audio check paused".into());
    }
    let state = app.state::<NativeState>();
    let errors = state.failures.lock().unwrap().clone();
    if !errors.is_empty() { return Err(format!("Frontend errors: {errors:?}")); }
    Ok(json!({"passed":true,"audio":true,"longCompressed":compressed,"forceStreaming":stream_only(),"checks":checks,"frontendErrors":errors,
        "syntheticAudioMuted":true,"defaultUserDataModified":false,
        "limits":["No subjective listening or device switch test","No process-wide peak-memory guarantee","Streamed handoff is not sample-accurate gapless"]}))
}
async fn run_recovery(app: &tauri::AppHandle) -> Result<Value, String> {
    wait_until(app, |state| state.ready.lock().unwrap().len() == 2
        && state.responsive.load(Ordering::SeqCst)).await?;
    let snapshot = || app.state::<NativeState>().snapshots.lock().unwrap()["main"].value.clone();
    let action = |value| core_action(app, "main", value);
    let initial = snapshot();
    let tracks = initial["library"]["tracks"].as_array().ok_or("Missing recovery fixtures")?;
    let ids: Vec<Value> = ["窓の光", "青い空"].iter().map(|title|
        tracks.iter().find(|track| track["title"] == *title).map(|track| track["id"].clone())
            .ok_or_else(|| format!("Missing recovery fixture {title}"))).collect::<Result<_,_>>()?;
    for value in [json!({"type":"setVolume","volume":0.22}), json!({"type":"setMuted","muted":true}),
        json!({"type":"playTracks","trackIds":ids,"startIndex":0})] {
        let result = action(value).await;
        if result["ok"] != true { return Err(format!("Recovery setup failed: {result}")); }
    }
    hide_windows(app)?;
    wait_until(app, |state| {
        let values = state.snapshots.lock().unwrap();
        values["main"].value["player"]["status"] == "playing"
            && values["main"].value["player"]["positionMs"].as_f64().unwrap_or(0.0) > 500.0
    }).await?;
    let entry = snapshot()["player"]["currentEntryId"].clone();
    let main = app.get_webview_window("main").unwrap();
    let mut checks = vec![json!({"name":"Muted recovery fixture plays while both native windows are hidden","passed":true})];
    for attempt in 1..=2 {
        let before = snapshot();
        let position = before["player"]["positionMs"].as_f64().unwrap();
        let notices = before["notices"].as_array().ok_or("Missing notice list")?.len();
        main.eval("window.__CD_OUTPUT_TEST_CONTEXT__.close().catch(e=>window.__TAURI_INTERNALS__.invoke('frontend_error',{message:String(e)}));")
            .map_err(|error| error.to_string())?;
        wait_until(app, |state| {
            let values = state.snapshots.lock().unwrap();
            let player = &values["main"].value["player"];
            player["status"] == "error" && player["error"]["code"] == "device"
                && values["mini"].value["player"]["status"] == "error"
        }).await?;
        tokio::time::sleep(Duration::from_millis(350)).await;
        let failed = snapshot();
        if failed["player"]["currentEntryId"] != entry || failed["notices"].as_array().unwrap().len() != notices + 1 {
            return Err(format!("Closed output skipped a queue entry or duplicated its notice: {failed}"));
        }
        checks.push(json!({"name":"Closed real AudioContext publishes one device error and retains the queue entry","passed":true,"attempt":attempt}));
        let result = action(json!({"type":"togglePlayback"})).await;
        if result["ok"] != true { return Err(format!("Explicit recovery failed: {result}")); }
        wait_until(app, |state| {
            let values = state.snapshots.lock().unwrap();
            let player = &values["main"].value["player"];
            player["status"] == "playing" && player["error"].is_null()
                && player["currentEntryId"] == entry && player["positionMs"].as_f64().unwrap_or(0.0) > position + 150.0
                && values["mini"].value["player"]["status"] == "playing"
        }).await?;
        let resumed = snapshot();
        if resumed["player"]["volume"] != 0.22 || resumed["player"]["muted"] != true
            || resumed["notices"].as_array().unwrap().len() != notices + 1 {
            return Err("Recovery reset volume/mute or created a redundant notice".into());
        }
        checks.push(json!({"name":"Play retries successfully using a fresh output and retained position","passed":true,
            "attempt":attempt,"beforeMs":position,"afterMs":resumed["player"]["positionMs"]}));
        checks.push(json!({"name":"Repeated output recovery preserves volume, mute and cross-surface state","passed":true,"attempt":attempt}));
    }
    if action(json!({"type":"togglePlayback"})).await["ok"] != true { return Err("Cannot pause after recovery".into()); }
    let position = snapshot()["player"]["positionMs"].as_f64().unwrap();
    tokio::time::sleep(Duration::from_millis(350)).await;
    let final_value = snapshot();
    if final_value["player"]["status"] != "paused" || final_value["player"]["currentEntryId"] != entry
        || (final_value["player"]["positionMs"].as_f64().unwrap() - position).abs() > 1.0 {
        return Err("User pause after recovery did not remain paused".into());
    }
    checks.push(json!({"name":"User pause after recovery keeps the position fixed","passed":true}));
    let errors = app.state::<NativeState>().failures.lock().unwrap().clone();
    if !errors.is_empty() { return Err(format!("Recovery frontend errors: {errors:?}")); }
    Ok(json!({"passed":true,"recovery":true,"checks":checks,"frontendErrors":errors,
        "realAudioContextsClosed":2,"syntheticAudioMuted":true,"defaultUserDataModified":false,
        "limits":["Deliberate AudioContext closure, not physical device unplug or sleep/wake",
            "No subjective quality or device output-rate measurement"]}))
}
async fn run_continuous(app: &tauri::AppHandle) -> Result<Value, String> {
    let Some(seconds) = soak_seconds(&std::env::args().collect::<Vec<_>>())? else {
        return run_continuous_cycle(app).await;
    };
    let started = Instant::now();
    let mut cycles = Vec::new();
    while started.elapsed() < Duration::from_secs(seconds) {
        // Finish every queue naturally; do not speed up the clock or attach an inspector.
        // Reuse this same native host/backend/profile across cycles.
        cycles.push(run_continuous_cycle(app).await?);
    }
    Ok(json!({"passed":true,"backgroundSoak":true,"forceStreaming":stream_only(),
        "requestedSeconds":seconds,"elapsedMs":started.elapsed().as_secs_f64()*1000.0,
        "cycles":cycles,"cycleCount":cycles.len(),"inspectorConnected":false,
        "syntheticAudioMuted":true,"defaultUserDataModified":false,
        "limits":["Every cycle ends naturally and briefly switches mini/full before hiding again",
            "No sleep/wake or physical output device switch; no sample-accurate gapless claim"]}))
}
async fn run_continuous_cycle(app: &tauri::AppHandle) -> Result<Value, String> {
    wait_until(app, |state| state.ready.lock().unwrap().len() == 2
        && state.responsive.load(Ordering::SeqCst)).await?;
    let mut idle_checks = Vec::new();
    if background() {
        hide_windows(app)?;
        // No inspector is connected and no audio is active during this hidden idle phase.
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_secs(6)).await;
            if !app.state::<NativeState>().responsive.load(Ordering::SeqCst) {
                return Err("Background idle core became unresponsive".into());
            }
            let begin=Instant::now();
            let result=core_action(app,"mini",json!({"type":"rescanLibrary"})).await;
            if result["ok"] != true || result["status"] != "started" {
                return Err(format!("Background idle rescan failed: {result}"));
            }
            wait_until(app,|s| s.snapshots.lock().unwrap()["main"].value["tasks"].as_array().is_some_and(|v|v.is_empty())).await?;
            idle_checks.push(json!({"action":"rescanLibrary","elapsedMs":begin.elapsed().as_secs_f64()*1000.0,"passed":true}));
        }
    }
    let tracks = {
        let state = app.state::<NativeState>();
        let values = state.snapshots.lock().unwrap();
        values["main"].value["library"]["tracks"].as_array()
            .ok_or("Missing continuous fixtures")?.clone()
    };
    let titles = ["窓の光", "青い空", "02 Wave", "01 Mp3"];
    let mut ids = Vec::new();
    for _ in 0..3 {
        for title in titles {
            ids.push(tracks.iter().find(|track| track["title"] == title)
                .ok_or_else(|| format!("Missing fixture {title}"))?["id"].clone());
        }
    }
    // Consecutive duplicate IDs must still advance their distinct queue entries.
    ids[1] = ids[0].clone();
    for value in [json!({"type":"setMuted","muted":true}),
        json!({"type":"playTracks","trackIds":ids,"startIndex":0})] {
        let result = core_action(app, "main", value).await;
        if result["ok"] != true { return Err(format!("Continuous setup failed: {result}")); }
    }
    hide_windows(app)?;
    let main = app.get_webview_window("main").unwrap();
    let mini = app.get_webview_window("mini").unwrap();
    let queue = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["player"]["queue"]
        .as_array().ok_or("Missing continuous queue")?.clone();
    let started = Instant::now();
    let mut entries = Vec::new();
    let mut positions = vec![0.0_f64; ids.len()];
    let mut last_index: Option<usize> = None;
    let mut samples = 0;
    let mut operations = Vec::new();
    loop {
        if started.elapsed() > Duration::from_secs(if background() {180} else {65}) { return Err("Continuous queue did not finish".into()); }
        if main.is_visible().unwrap_or(true) || mini.is_visible().unwrap_or(true) {
            return Err("A hidden playback window unexpectedly became visible".into());
        }
        let state = app.state::<NativeState>();
        if !state.responsive.load(Ordering::SeqCst) || !state.failures.lock().unwrap().is_empty() {
            return Err("Core disconnected or frontend failed during hidden continuous playback".into());
        }
        let value = state.snapshots.lock().unwrap()["main"].value.clone();
        let player = &value["player"];
        let index = player["currentQueueIndex"].as_u64().ok_or("Missing queue index")? as usize;
        if index >= ids.len() || player["currentTrackId"] != ids[index]
            || player["currentEntryId"] != queue[index]["id"]
            || value["lyrics"]["trackId"] != ids[index] {
            return Err(format!("Track/entry/lyrics are inconsistent at entry {index}"));
        }
        if last_index != Some(index) {
            if index != entries.len() { return Err(format!("Queue skipped or repeated an entry: {index}")); }
            entries.push(json!({"index":index,"entryId":queue[index]["id"],"trackId":ids[index],
                "elapsedMs":started.elapsed().as_secs_f64()*1000.0,"lyricsMatch":true}));
            last_index = Some(index);
        }
        let position = player["positionMs"].as_f64().ok_or("Missing playback position")?;
        if position + 1.0 < positions[index] { return Err(format!("Audio clock moved backwards at entry {index}")); }
        positions[index] = position;
        samples += 1;
        if player["status"] == "paused" {
            if index != ids.len() - 1 || position < player["durationMs"].as_f64().unwrap_or(f64::INFINITY) - 1.0 {
                return Err("Queue paused before its natural end".into());
            }
            break;
        }
        if player["status"] != "playing" && player["status"] != "buffering" {
            return Err(format!("Unexpected continuous player state: {}", player["status"]));
        }
        if background() && samples % 160 == 0 {
            // Exercise the same native relay used by tray/global actions while audio advances.
            let before_revision=value["library"]["revision"].as_u64().unwrap();
            let begin=Instant::now();let result=core_action(app,"mini",json!({"type":"rescanLibrary"})).await;
            if result["ok"] != true || result["status"] != "started" { return Err(format!("Background playing rescan failed: {result}")); }
            operations.push(json!({"action":"rescanLibrary","elapsedMs":begin.elapsed().as_secs_f64()*1000.0,"passed":true}));
            wait_until(app,|s| { let values=s.snapshots.lock().unwrap(); let v=&values["main"].value;
                v["tasks"].as_array().is_some_and(|v|v.is_empty()) && v["library"]["revision"].as_u64().unwrap_or(0)>before_revision }).await?;
            // A pause/resume pair must retain the current queue entry and stay hidden.
            let before=app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["player"]["currentEntryId"].clone();
            for expected in ["paused","playing"] {
                let begin=Instant::now();let result=core_action(app,"mini",json!({"type":"togglePlayback"})).await;
                if result["ok"] != true {return Err(format!("Background playback command failed: {result}"));}
                wait_until(app,|s| s.snapshots.lock().unwrap()["main"].value["player"]["status"]==expected).await?;
                operations.push(json!({"action":"togglePlayback","status":expected,"elapsedMs":begin.elapsed().as_secs_f64()*1000.0,"passed":true}));
            }
            if app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["player"]["currentEntryId"] != before { return Err("Background pause/resume changed the queue entry".into()); }
        }
        tokio::time::sleep(Duration::from_millis(75)).await;
    }
    wait_until(app, |state| {
        let values = state.snapshots.lock().unwrap();
        values["mini"].value["player"]["status"] == "paused"
            && values["mini"].value["player"]["currentEntryId"] == queue.last().unwrap()["id"]
    }).await?;
    if positions.iter().any(|position| *position < 1000.0) {
        return Err("An entry never reported an advancing audio clock".into());
    }
    if background() {
        switch_window(app,"mini")?;switch_window(app,"full")?;hide_windows(app)?;
    }
    Ok(json!({"passed":true,"continuous":true,"background":background(),"forceStreaming":stream_only(),"entries":entries,
        "idleChecks":idle_checks,"backgroundOperations":operations,
        "entryCount":ids.len(),"samples":samples,"elapsedMs":started.elapsed().as_secs_f64()*1000.0,
        "maximumPositionsMs":positions,"bothWindowsHidden":true,"queueEndedNaturally":true,
        "frontendErrors":[],"syntheticAudioMuted":true,"defaultUserDataModified":false,
        "limits":["Minute-scale playback, not an hour-scale stress test","No sleep/wake or physical device switch",
            "No subjective listening or sample-accurate streamed gapless measurement"]}))
}
#[cfg(test)]
mod soak_tests {
    use super::soak_seconds;
    fn args(values: &[&str]) -> Vec<String> { values.iter().map(|v| v.to_string()).collect() }
    #[test]
    fn opt_in_duration_preserves_default_and_accepts_hour_runs() {
        assert_eq!(soak_seconds(&args(&["app", "--smoke-background"])).unwrap(), None);
        assert_eq!(soak_seconds(&args(&["app", "--smoke-background", "--smoke-soak-seconds", "3600"])).unwrap(), Some(3600));
    }
    #[test]
    fn bad_duplicate_or_non_background_durations_are_rejected() {
        for input in [vec!["--smoke-soak-seconds", "3600"],
            vec!["--smoke-background", "--smoke-soak-seconds"],
            vec!["--smoke-background", "--smoke-soak-seconds", "59"],
            vec!["--smoke-background", "--smoke-soak-seconds", "86401"],
            vec!["--smoke-background", "--smoke-soak-seconds", "x"],
            vec!["--smoke-background", "--smoke-soak-seconds", "60", "--smoke-soak-seconds", "60"]] {
            assert!(soak_seconds(&args(&input)).is_err(), "{input:?}");
        }
    }
}
#[cfg(windows)]
async fn run_materials(app: &tauri::AppHandle) -> Result<Value, String> {
    wait_until(app, |state| state.ready.lock().unwrap().len() == 2
        && state.responsive.load(Ordering::SeqCst)).await?;
    let main = app.get_webview_window("main").unwrap();
    let mini = app.get_webview_window("mini").unwrap();
    let original = app.state::<NativeState>().snapshots.lock().unwrap()["main"].value["settings"].clone();
    let preferences = app.state::<NativeState>().materials.lock().unwrap().preferences;
    let snapshot = || app.state::<NativeState>().snapshots.lock().unwrap()["main"].value.clone();
    let mut checks = Vec::new();
    let update = |patch| core_action(app, "main", json!({"type":"updateSettings","patch":patch}));
    let result = update(json!({"glassIntensity":0.65,"motion":"system","background":"blue","ui":{"main":{"materialTheme":"standard"}}})).await;
    if result["ok"] != true { return Err(format!("Material setup failed: {result}")); }
    wait_until(app, |state| state.snapshots.lock().unwrap()["mini"].value["settings"]["glassIntensity"] == 0.65).await?;
    let initial = snapshot()["host"].clone();
    let attribute = materials::native_backdrop(&main);
    if initial["backdrop"] == "mica" && attribute != Some(2) {
        return Err("Effective Mica lacks a matching DWM readback".into());
    }
    if initial["transparencyAllowed"] != preferences.transparency && !preferences.high_contrast
        && !preferences.battery_saver && !preferences.remote && preferences.composition {
        return Err("Main incorrectly denied the system transparency preference".into());
    }
    let mini_host = app.state::<NativeState>().snapshots.lock().unwrap()["mini"].value["host"].clone();
    if mini_host["backdrop"] != "none" || mini_host["capabilities"]["transparentWindow"] != true {
        return Err("Mini material filled the existing transparent margin".into());
    }
    checks.push(json!({"name":"Main reports the checked DWM material and mini retains its transparent frame",
        "passed":true,"mainHost":initial,"miniHost":mini_host,"dwmBackdrop":attribute}));
    for (name, patch, dark) in [
        ("charcoal", json!({"ui":{"main":{"materialTheme":"charcoal"}}}), true),
        ("paper", json!({"background":"light","ui":{"main":{"materialTheme":"standard"}}}), false),
        ("blue", json!({"background":"blue","ui":{"main":{"materialTheme":"standard"}}}), false)] {
        if update(patch).await["ok"] != true { return Err(format!("Theme {name} update failed")); }
        let value = materials::native_dark(&main);
        if attribute.is_some() && value != Some(dark) {
            return Err(format!("Native theme disagrees with {name}: {value:?}"));
        }
    }
    checks.push(json!({"name":"Native dark/light attributes follow charcoal, paper and Argentina blue","passed":true}));
    if update(json!({"glassIntensity":0})).await["ok"] != true { return Err("Glass-off update failed".into()); }
    if snapshot()["host"]["backdrop"] != "none"
        || (attribute.is_some() && materials::native_backdrop(&main) != Some(1)) {
        return Err("Glass intensity zero left native Mica enabled".into());
    }
    if update(json!({"glassIntensity":0.65})).await["ok"] != true { return Err("Glass restore failed".into()); }
    if snapshot()["host"]["backdrop"] != initial["backdrop"] { return Err("Restoring glass did not restore material".into()); }
    checks.push(json!({"name":"Glass-off clears DWM backdrop; restoring the value restores the original material","passed":true}));
    for (name, policy) in [
        ("transparency disabled", materials::Preferences { transparency: false, ..preferences }),
        ("high contrast and reduced animations", materials::Preferences { high_contrast: true, animations: false, ..preferences }),
        ("battery saver", materials::Preferences { battery_saver: true, ..preferences }),
        ("remote session", materials::Preferences { remote: true, ..preferences })] {
        app.state::<NativeState>().materials.lock().unwrap().set_test_preferences(Some(policy));
        refresh_hosts(app)?;
        let state = app.state::<NativeState>();
        let values = state.snapshots.lock().unwrap();
        for surface in ["main", "mini"] {
            let host = &values[surface].value["host"];
            if host["backdrop"] != "none" || host["transparencyAllowed"] != false
                || (name.starts_with("high contrast") && host["effectiveReducedMotion"] != true) {
                return Err(format!("{name} did not apply a solid fallback to {surface}"));
            }
        }
        if attribute.is_some() && materials::native_backdrop(&main) != Some(1) {
            return Err(format!("{name} did not clear the native DWM effect"));
        }
        checks.push(json!({"name":format!("Isolated policy: {name} clears native material and publishes both surface fallbacks"),"passed":true,
            "systemSettingsModified":false}));
    }
    app.state::<NativeState>().materials.lock().unwrap().set_test_preferences(None);
    refresh_hosts(app)?;
    if snapshot()["host"]["backdrop"] != initial["backdrop"] { return Err("Policy fallback did not restore original material".into()); }
    let result = update(original.clone()).await;
    if result["ok"] != true { return Err(format!("Original settings restore failed: {result}")); }
    switch_window(app, "mini")?;
    hide_windows(app)?;
    if main.is_visible().unwrap_or(true) || mini.is_visible().unwrap_or(true) { return Err("Material transition showed a hidden window".into()); }
    let errors = app.state::<NativeState>().failures.lock().unwrap().clone();
    if !errors.is_empty() { return Err(format!("Frontend errors: {errors:?}")); }
    checks.push(json!({"name":"Policy and settings restore, window switching and hiding retain the two-window lifecycle","passed":true}));
    Ok(json!({"passed":true,"materials":true,"checks":checks,"frontendErrors":errors,
        "systemPreferences":{"transparency":preferences.transparency,"composition":preferences.composition,
            "highContrast":preferences.high_contrast,"batterySaver":preferences.battery_saver,"remote":preferences.remote,"animations":preferences.animations},
        "systemSettingsModified":false,"defaultUserDataModified":false,"miniAcrylicEnabled":false,
        "limits":["DWM acknowledgement and readback are not visual aesthetic acceptance","Fallbacks use an isolated policy override, not global system setting changes",
            "Windows 10 and older Windows 11 builds were not tested","Mini Acrylic awaits transparent-margin design alignment"]}))
}
#[cfg(not(windows))]
async fn run_materials(_: &tauri::AppHandle) -> Result<Value, String> { Err("Material diagnostic requires Windows".into()) }
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let options = options().unwrap().unwrap();
        let prepared = if hotkeys() {
            prepare_manual_hotkeys(&app).await
        } else {
            Ok(())
        };
        let result = if let Err(error) = prepared {
            Err(error)
        } else if recovery() {
            run_recovery(&app).await
        } else if materials() {
            run_materials(&app).await
        } else if continuous() || background() {
            run_continuous(&app).await
        } else if audio() {
            run_audio(&app).await
        } else if manual() {
            let stop = options.report.with_extension("stop");
            let until = Instant::now() + Duration::from_secs(600);
            while !stop.exists() && Instant::now() < until {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let state = app.state::<NativeState>();
            let values = state.snapshots.lock().unwrap();
            let main = values.get("main").map(|v| &v.value);
            let errors = state.failures.lock().unwrap().clone();
            #[cfg(windows)]
            let shortcuts = json!({"registration":app.state::<ShortcutState>().help.clone(),"events":app.state::<ShortcutState>().events.lock().unwrap().clone()});
            #[cfg(not(windows))]
            let shortcuts = Value::Null;
            Ok(
                json!({"passed":stop.exists() && errors.is_empty() && state.responsive.load(Ordering::SeqCst),
                "manual":true,"libraryAlbums":main.map(|v| v["library"]["albums"].as_array().map(|a| a.len())),
                "libraryTracks":main.map(|v| v["library"]["tracks"].as_array().map(|a| a.len())),
                "playerStatus":main.map(|v| v["player"]["status"].clone()),"frontendErrors":errors,"shortcuts":shortcuts}),
            )
        } else {
            run(&app).await
        };
        let report = match result {
            Ok(report) => report,
            Err(error) => {
                json!({"passed":false,"error":error,"frontendErrors":app.state::<NativeState>().failures.lock().unwrap().clone(),"readySurfaces":app.state::<NativeState>().ready.lock().unwrap().clone()})
            }
        };
        let _ = std::fs::write(options.report, serde_json::to_vec_pretty(&report).unwrap());
        app.state::<NativeState>()
            .exiting
            .store(true, Ordering::SeqCst);
        let close_app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || stop_backend(&close_app)).await;
        app.exit(if report["passed"] == true { 0 } else { 1 });
    });
}
