//! Windows registrations live on their own message thread, independently of WebView focus.
//! No keyboard hook is installed; Windows delivers only the three registered chords.
use std::{
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use windows_sys::Win32::{
    System::Threading::GetCurrentThreadId,
    UI::{
        Input::KeyboardAndMouse::{
            RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
        },
        WindowsAndMessaging::{
            GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_HOTKEY, WM_QUIT,
        },
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Binding {
    pub id: i32,
    pub key: u32,
    pub modifiers: u32,
    pub action: &'static str,
    pub label: &'static str,
}
pub const BINDINGS: [Binding; 3] = [
    Binding {
        id: 1,
        key: 0x25,
        modifiers: MOD_CONTROL | MOD_ALT,
        action: "previous",
        label: "上一首：Ctrl + Alt + ←",
    },
    Binding {
        id: 2,
        key: 0x27,
        modifiers: MOD_CONTROL | MOD_ALT,
        action: "next",
        label: "下一首：Ctrl + Alt + →",
    },
    Binding {
        id: 3,
        key: 0x50,
        modifiers: MOD_CONTROL | MOD_ALT,
        action: "togglePlayback",
        label: "播放 / 暂停：Ctrl + Alt + P",
    },
];
#[derive(Clone, Debug)]
pub struct Registration {
    pub binding: Binding,
    pub error: Option<i32>,
}
pub struct Service {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
    stopped: Arc<AtomicBool>,
    pub registrations: Vec<Registration>,
}
impl Service {
    pub fn start(
        bindings: Vec<Binding>,
        mut callback: impl FnMut(Binding) + Send + 'static,
    ) -> io::Result<Self> {
        let stopped = Arc::new(AtomicBool::new(false));
        let stopping = stopped.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("cd-global-shortcuts".into())
            .spawn(move || {
                // Create the queue before reporting ready so shutdown messages cannot race it.
                let mut message = MSG::default();
                unsafe {
                    PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
                }
                let registrations = bindings
                    .into_iter()
                    .map(|binding| {
                        let success = unsafe {
                            RegisterHotKey(
                                std::ptr::null_mut(),
                                binding.id,
                                binding.modifiers | MOD_NOREPEAT,
                                binding.key,
                            )
                        };
                        Registration {
                            binding,
                            error: if success != 0 {
                                None
                            } else {
                                io::Error::last_os_error().raw_os_error().or(Some(-1))
                            },
                        }
                    })
                    .collect::<Vec<_>>();
                let thread_id = unsafe { GetCurrentThreadId() };
                if ready_tx.send((thread_id, registrations.clone())).is_ok() {
                    while !stopping.load(Ordering::SeqCst) {
                        let result =
                            unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
                        if result <= 0 || stopping.load(Ordering::SeqCst) {
                            break;
                        }
                        if message.message == WM_HOTKEY {
                            if let Some(binding) =
                                matched_binding(&registrations, message.wParam, message.lParam)
                            {
                                callback(binding);
                            }
                        }
                    }
                }
                for registration in registrations.iter().filter(|r| r.error.is_none()) {
                    unsafe {
                        UnregisterHotKey(std::ptr::null_mut(), registration.binding.id);
                    }
                }
            })?;
        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok((thread_id, registrations)) => Ok(Self {
                thread_id,
                thread: Some(worker),
                stopped,
                registrations,
            }),
            Err(error) => {
                stopped.store(true, Ordering::SeqCst);
                Err(io::Error::other(error.to_string()))
            }
        }
    }
    pub fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.thread.take() {
            let posted = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
            if posted != 0 || worker.is_finished() {
                let _ = worker.join();
            }
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.stop();
    }
}

fn matched_binding(registrations: &[Registration], id: usize, chord: isize) -> Option<Binding> {
    let modifiers = chord as u32 & 0xffff;
    let key = (chord as u32 >> 16) & 0xffff;
    registrations
        .iter()
        .find(|r| {
            r.error.is_none()
                && r.binding.id as usize == id
                && r.binding.key == key
                && r.binding.modifiers == modifiers
        })
        .map(|r| r.binding)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dispatch_requires_a_successful_registration_and_matching_chord() {
        let registered = Registration {
            binding: BINDINGS[0],
            error: None,
        };
        let chord = ((registered.binding.key << 16) | registered.binding.modifiers) as isize;
        assert_eq!(
            matched_binding(&[registered.clone()], 1, chord),
            Some(BINDINGS[0])
        );
        assert_eq!(matched_binding(&[registered.clone()], 2, chord), None);
        assert_eq!(matched_binding(&[registered.clone()], 1, 0), None);
        assert_eq!(
            matched_binding(
                &[Registration {
                    error: Some(1409),
                    ..registered
                }],
                1,
                chord
            ),
            None
        );
    }
    #[test]
    fn windows_registration_dispatch_collision_and_release() {
        // A nonstandard chord keeps this isolated test away from normal player shortcuts.
        let binding = Binding {
            id: 71,
            key: 0x87,
            modifiers: MOD_CONTROL | MOD_ALT | 4,
            action: "next",
            label: "test",
        };
        let (tx, rx) = mpsc::channel();
        let mut first = Service::start(vec![binding], move |key| {
            tx.send(key.action).unwrap();
        })
        .unwrap();
        assert_eq!(first.registrations[0].error, None);
        let chord = ((binding.key << 16) | binding.modifiers) as isize;
        assert_ne!(
            unsafe { PostThreadMessageW(first.thread_id, WM_HOTKEY, binding.id as usize, chord) },
            0
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "next");
        let mut conflicting =
            Service::start(vec![binding], |_| panic!("Conflicting hotkey dispatched")).unwrap();
        assert_eq!(conflicting.registrations[0].error, Some(1409));
        conflicting.stop();
        first.stop();
        let mut reopened = Service::start(vec![binding], |_| {}).unwrap();
        assert_eq!(reopened.registrations[0].error, None);
        reopened.stop();
    }
}
