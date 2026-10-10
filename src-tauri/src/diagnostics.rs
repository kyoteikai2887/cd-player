//! Bounded, local action timing; never writes action parameters, metadata or errors.
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const LIMIT: u64 = 256 * 1024;
const ARCHIVES: usize = 3;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    Sent,
    Received,
    Handled,
    Published,
}
impl Stage {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "received" => Some(Self::Received),
            "handled" => Some(Self::Handled),
            "published" => Some(Self::Published),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Sent => "sent",
            Self::Received => "received",
            Self::Handled => "handled",
            Self::Published => "published",
        }
    }
}
pub fn action_name(name: &str) -> &'static str {
    match name {
        "playAlbum" => "playAlbum",
        "playTracks" => "playTracks",
        "playQueueEntry" => "playQueueEntry",
        "togglePlayback" => "togglePlayback",
        "previous" => "previous",
        "next" => "next",
        "seek" => "seek",
        "setVolume" => "setVolume",
        "setMuted" => "setMuted",
        "setRepeat" => "setRepeat",
        "setShuffle" => "setShuffle",
        "reorderQueue" => "reorderQueue",
        "removeQueueEntry" => "removeQueueEntry",
        "clearQueue" => "clearQueue",
        "importFolder" => "importFolder",
        "rescanLibrary" => "rescanLibrary",
        "cancelTask" => "cancelTask",
        "openLyricsEditor" => "openLyricsEditor",
        "closeLyricsEditor" => "closeLyricsEditor",
        "saveLyrics" => "saveLyrics",
        "importLyrics" => "importLyrics",
        "exportLyrics" => "exportLyrics",
        "setLyricsOffset" => "setLyricsOffset",
        "setNoLyrics" => "setNoLyrics",
        "updateAlbum" => "updateAlbum",
        "updateTrack" => "updateTrack",
        "chooseCover" => "chooseCover",
        "updateSettings" => "updateSettings",
        "lookupMetadata" => "lookupMetadata",
        "applyMetadataCandidate" => "applyMetadataCandidate",
        "closeMetadataReview" => "closeMetadataReview",
        "lookupLyrics" => "lookupLyrics",
        "searchLyricsCandidates" => "searchLyricsCandidates",
        "applyLyricsCandidate" => "applyLyricsCandidate",
        "closeLyricsReview" => "closeLyricsReview",
        "removeAlbum" => "removeAlbum",
        "dismissNotice" => "dismissNotice",
        _ => "other",
    }
}
pub fn outcome(result: &Value) -> &'static str {
    let code = if result["ok"] == true {
        result["status"].as_str()
    } else {
        result["code"].as_str()
    };
    match code.unwrap_or("") {
        "applied" => "applied",
        "started" => "started",
        "cancelled" => "cancelled",
        "conflict" => "conflict",
        "locked" => "locked",
        "invalidAction" => "invalidAction",
        "notFound" => "notFound",
        "fileMissing" => "fileMissing",
        "unavailable" => "unavailable",
        "unsupported" => "unsupported",
        "io" => "io",
        "device" => "device",
        _ => "unknown",
    }
}
fn ordinary(path: &Path, directory: bool) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("Reparse path rejected"));
        }
    }
    if meta.file_type().is_symlink()
        || meta.is_dir() != directory
        || (!directory && !meta.is_file())
    {
        return Err(io::Error::other("Unexpected diagnostic path"));
    }
    Ok(())
}
struct Writer {
    directory: PathBuf,
    file: Option<File>,
    size: u64,
    limit: u64,
}
impl Writer {
    fn path(&self, n: usize) -> PathBuf {
        self.directory.join(if n == 0 {
            "diagnostics.ndjson".into()
        } else {
            format!("diagnostics.{n}.ndjson")
        })
    }
    fn new(data: &Path, limit: u64) -> io::Result<Self> {
        ordinary(data, true)?;
        let directory = data.join("logs");
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        ordinary(&directory, true)?;
        let mut writer = Self {
            directory,
            file: None,
            size: 0,
            limit,
        };
        writer.open()?;
        Ok(writer)
    }
    fn open(&mut self) -> io::Result<()> {
        let path = self.path(0);
        if path.try_exists()? {
            ordinary(&path, false)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        self.size = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }
    fn append(&mut self, value: &Value) -> io::Result<()> {
        let mut line = serde_json::to_vec(value)?;
        line.push(b'\n');
        if line.len() as u64 > self.limit {
            return Ok(());
        }
        if self.size + line.len() as u64 > self.limit {
            // All targets are literal filenames under the already checked private logs folder.
            ordinary(&self.directory, true)?;
            for n in 0..=ARCHIVES {
                let p = self.path(n);
                if p.try_exists()? {
                    ordinary(&p, false)?;
                }
            }
            self.file.take();
            if self.path(ARCHIVES).try_exists()? {
                fs::remove_file(self.path(ARCHIVES))?;
            }
            for n in (0..ARCHIVES).rev() {
                if self.path(n).try_exists()? {
                    fs::rename(self.path(n), self.path(n + 1))?;
                }
            }
            self.open()?;
        }
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::other("Diagnostic writer closed"))?
            .write_all(&line)?;
        self.size += line.len() as u64;
        Ok(())
    }
}
pub struct Recorder {
    sender: Mutex<Option<mpsc::SyncSender<Value>>>,
    completed: Mutex<Option<mpsc::Receiver<()>>>,
    session: String,
}
impl Recorder {
    pub fn new(data: &Path) -> Self {
        let directory = data.to_path_buf();
        let (sender, receiver) = mpsc::sync_channel(128);
        let (done, completed) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("cd-local-diagnostics".into())
            .spawn(move || {
                if let Ok(mut writer) = Writer::new(&directory, LIMIT) {
                    for record in receiver {
                        if writer.append(&record).is_err() {
                            break;
                        }
                    }
                }
                let _ = done.send(());
            })
            .is_ok();
        Self {
            sender: Mutex::new(spawned.then_some(sender)),
            completed: Mutex::new(spawned.then_some(completed)),
            session: uuid::Uuid::new_v4().to_string(),
        }
    }
    fn write(&self, mut record: Value) {
        record["atMs"] = json!(SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64);
        record["session"] = json!(self.session);
        let Ok(mut sender) = self.sender.lock() else {
            return;
        };
        // Drop a diagnostic if the bounded queue is full; never perform disk I/O here.
        if let Some(active) = sender.as_ref() {
            if let Err(mpsc::TrySendError::Disconnected(_)) = active.try_send(record) {
                *sender = None;
            }
        }
    }
    pub fn finish(&self) {
        if let Ok(mut sender) = self.sender.lock() {
            sender.take();
        }
        if let Ok(mut completed) = self.completed.lock() {
            if let Some(done) = completed.take() {
                let _ = done.recv_timeout(Duration::from_millis(250));
            }
        }
    }
    pub fn lifecycle(&self, event: &'static str) {
        if matches!(event, "started" | "stopping" | "stopped") {
            self.write(json!({"event":event,"version":env!("CARGO_PKG_VERSION")}));
        }
    }
    pub fn renderer(&self, surface: &str, event: &str, kind: Option<i32>) {
        if !matches!(surface, "main" | "mini") || !matches!(event,
            "process_failed" | "observer_failed" | "resume_failed" |
            "recovery_requested" | "recovery_cancelled" | "recovery_started" | "recovery_failed" | "surface_ready" | "frontend_error") {
            return;
        }
        self.write(json!({"event":"renderer","surface":surface,"operation":event,"kind":kind.filter(|n| (0..=10).contains(n))}));
    }
    pub fn health(&self, ready: bool) {
        self.write(json!({"event":"health","ready":ready}));
    }
    pub fn action(
        &self,
        id: &str,
        name: &str,
        event: &'static str,
        stage: Stage,
        elapsed_ms: u64,
        result: Option<&Value>,
    ) {
        // Action IDs are generated by the native host. Reject any external-looking value.
        if uuid::Uuid::parse_str(id).is_err()
            || !matches!(
                event,
                "action_sent"
                    | "action_stage"
                    | "action_result"
                    | "action_timeout"
                    | "action_emit_failed"
            )
        {
            return;
        }
        self.write(json!({"event":event,"id":id,"action":action_name(name),"stage":stage.name(),"elapsedMs":elapsed_ms,
            "outcome":result.map(outcome)}));
    }
}
impl Drop for Recorder {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("cd-diagnostics-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let p = fs::canonicalize(&self.0).unwrap();
            let base = fs::canonicalize(std::env::temp_dir()).unwrap();
            assert_eq!(p.parent(), Some(base.as_path()));
            assert!(p
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cd-diagnostics-"));
            fs::remove_dir_all(p).unwrap();
        }
    }
    #[test]
    fn renderer_records_only_known_surfaces_operations_and_bounded_numeric_kinds() {
        let temp = Temp::new();
        let r = Recorder::new(&temp.0);
        r.renderer("main", "process_failed", Some(2));
        r.renderer("mini", "surface_ready", None);
        r.renderer("main", "frontend_error", None);
        r.renderer("private song", "process_failed", Some(4));
        r.renderer("main", "private lyrics", Some(4));
        r.renderer("main", "process_failed", Some(9000));
        r.finish();
        let text = fs::read_to_string(temp.0.join("logs/diagnostics.ndjson")).unwrap();
        assert_eq!(text.lines().count(), 4);
        assert!(!text.contains("private") && !text.contains("9000"));
        assert!(text.contains("\"kind\":2") && text.contains("\"kind\":null"));
    }
    #[test]
    fn rotation_keeps_four_bounded_files_and_the_newest_complete_record() {
        let temp = Temp::new();
        let mut w = Writer::new(&temp.0, 220).unwrap();
        for n in 0..60 {
            w.append(
                &json!({"event":"action_result","number":n,"padding":"abcdefghijklmnopqrstuvwxyz"}),
            )
            .unwrap();
        }
        drop(w);
        let paths = fs::read_dir(temp.0.join("logs"))
            .unwrap()
            .map(|p| p.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(paths.len(), 4);
        for p in paths {
            assert!(fs::metadata(&p).unwrap().len() <= 220);
            for line in fs::read_to_string(p).unwrap().lines() {
                serde_json::from_str::<Value>(line).unwrap();
            }
        }
        assert!(fs::read_to_string(temp.0.join("logs/diagnostics.ndjson"))
            .unwrap()
            .contains("59"));
    }
    #[test]
    fn sensitive_names_and_result_messages_are_not_serialized() {
        let temp = Temp::new();
        let r = Recorder::new(&temp.0);
        r.action(
            &uuid::Uuid::new_v4().to_string(),
            "C:/private/song.flac",
            "action_result",
            Stage::Handled,
            4,
            Some(&json!({"ok":false,"code":"secret lyric","message":"private translated lyrics"})),
        );
        r.action(
            "private-track-id",
            "saveLyrics",
            "action_result",
            Stage::Handled,
            8,
            None,
        );
        r.finish();
        let text = fs::read_to_string(temp.0.join("logs/diagnostics.ndjson")).unwrap();
        assert!(text.contains("other") && text.contains("unknown"));
        assert!(
            !text.contains("private") && !text.contains("translated") && !text.contains("secret")
        );
        assert_eq!(text.lines().count(), 1);
    }
    #[test]
    fn logging_failure_disables_recording_without_affecting_the_caller() {
        let temp = Temp::new();
        fs::write(temp.0.join("logs"), "occupied").unwrap();
        let r = Recorder::new(&temp.0);
        r.lifecycle("started");
        r.health(true);
        r.finish();
        r.health(false);
        assert_eq!(fs::read_to_string(temp.0.join("logs")).unwrap(), "occupied");
    }
    #[test]
    fn a_full_diagnostic_queue_drops_records_instead_of_waiting_or_growing() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let (done, finished) = mpsc::channel();
        let r = Recorder {
            sender: Mutex::new(Some(sender)),
            completed: Mutex::new(None),
            session: "original-test".into(),
        };
        let worker = std::thread::spawn(move || {
            for _ in 0..1000 {
                r.health(true);
            }
            let _ = done.send(());
        });
        finished
            .recv_timeout(Duration::from_secs(2))
            .expect("A full log queue blocked the caller");
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err());
        worker.join().unwrap();
    }
    #[test]
    fn occupied_archive_is_not_deleted_or_overwritten() {
        let temp = Temp::new();
        let mut w = Writer::new(&temp.0, 70).unwrap();
        fs::create_dir(w.path(3)).unwrap();
        w.append(&json!({"first":"abcdefghijklmnopqrstuvwxyz"}))
            .unwrap();
        assert!(w
            .append(&json!({"second":"abcdefghijklmnopqrstuvwxyz"}))
            .is_err());
        assert!(w.path(3).is_dir());
    }
    #[test]
    fn only_valid_monotone_renderer_stages_are_accepted() {
        assert!(Stage::parse("arbitrary").is_none());
        assert!(Stage::Received > Stage::Sent);
        assert!(Stage::Handled > Stage::Received && Stage::Published > Stage::Handled);
        assert_eq!(
            outcome(&json!({"ok":false,"code":"conflict","message":"do not log"})),
            "conflict"
        );
    }
}
