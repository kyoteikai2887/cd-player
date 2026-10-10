//! WebView2 recovery support. Never reload automatically or discard UI drafts.
use tauri::{Manager, WebviewWindow};
#[cfg(windows)]
use webview2_com::{Microsoft::Web::WebView2::Win32::*, ProcessFailedEventHandler};
#[cfg(windows)]
use windows_core::Interface;

pub fn observe(window: &WebviewWindow) {
    #[cfg(windows)] {
        let app = window.app_handle().clone();
        let surface = window.label().to_string();
        let failed_app = app.clone();
        let failed_surface = surface.clone();
        let result = window.with_webview(move |platform| {
            let result = (|| -> windows_core::Result<()> {
                let core = unsafe { platform.controller().CoreWebView2()? };
                let mut token = 0;
                unsafe {
                    core.add_ProcessFailed(&ProcessFailedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
                            if args.ProcessFailedKind(&mut kind).is_ok() {
                                // Kind only: no executable description, URLs, command lines or dump paths.
                                failed_app.state::<super::NativeState>().logs.renderer(&failed_surface, "process_failed", Some(kind.0));
                            }
                        }
                        Ok(())
                    })), &mut token)?;
                }
                // The WebView owns the registered handler until the control closes.
                Ok(())
            })();
            if result.is_err() {
                app.state::<super::NativeState>().logs.renderer(&surface, "observer_failed", None);
            }
        });
        if result.is_err() {
            window.app_handle().state::<super::NativeState>().logs.renderer(window.label(), "observer_failed", None);
        }
    }
    #[cfg(not(windows))] let _ = window;
}

/// Resume a suspended control when the user brings the player forward. This
/// does not navigate, change playback, or destroy a draft in either surface.
pub fn resume(window: &WebviewWindow) {
    #[cfg(windows)] {
        let app = window.app_handle().clone();
        let surface = window.label().to_string();
        let result = window.with_webview(move |platform| {
            let result = (|| -> windows_core::Result<()> {
                let core = unsafe { platform.controller().CoreWebView2()? };
                let resumable: ICoreWebView2_3 = core.cast()?;
                unsafe { resumable.Resume() }
            })();
            if result.is_err() {
                app.state::<super::NativeState>().logs.renderer(&surface, "resume_failed", None);
            }
        });
        if result.is_err() {
            window.app_handle().state::<super::NativeState>().logs.renderer(window.label(), "resume_failed", None);
        }
    }
    #[cfg(not(windows))] let _ = window;
}
