// Native policy only. Claude owns the visual composition of both surfaces.
use serde_json::Value;
use std::collections::HashMap;
use tauri::WebviewWindow;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Preferences {
    pub transparency: bool,
    pub composition: bool,
    pub high_contrast: bool,
    pub battery_saver: bool,
    pub remote: bool,
    pub animations: bool,
}
impl Preferences {
    fn allows_transparency(self) -> bool {
        self.transparency
            && self.composition
            && !self.high_contrast
            && !self.battery_saver
            && !self.remote
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Plan {
    transparency_allowed: bool,
    mica: bool,
    dark: bool,
    reduced_motion: bool,
}
impl Plan {
    fn new(surface: &str, settings: &Value, preferences: Preferences) -> Self {
        let allowed = preferences.allows_transparency();
        Self {
            transparency_allowed: allowed,
            // Acrylic fills the mini's 12px transparent margin. Keep that surface's
            // existing transparent frame until its visual treatment is aligned with Claude.
            mica: surface == "main"
                && allowed
                && settings["glassIntensity"].as_f64().unwrap_or(0.65) > 0.0,
            dark: settings["ui"]["main"]["materialTheme"] == "charcoal",
            reduced_motion: settings["motion"] == "reduced"
                || (settings["motion"] == "system" && !preferences.animations),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Host {
    pub backdrop: &'static str,
    pub transparency_allowed: bool,
    pub reduced_motion: bool,
}
pub struct State {
    pub preferences: Preferences,
    windows: HashMap<String, (Plan, Host)>,
    #[cfg(debug_assertions)]
    test_preferences: Option<Preferences>,
}
impl State {
    pub fn new() -> Self {
        Self {
            preferences: read_preferences(),
            windows: HashMap::new(),
            #[cfg(debug_assertions)]
            test_preferences: None,
        }
    }
    pub fn refresh(&mut self) -> bool {
        #[cfg(debug_assertions)]
        let preferences = self.test_preferences.unwrap_or_else(read_preferences);
        #[cfg(not(debug_assertions))]
        let preferences = read_preferences();
        self.set_preferences(preferences)
    }
    #[cfg(debug_assertions)]
    pub fn set_test_preferences(&mut self, preferences: Option<Preferences>) {
        self.test_preferences = preferences;
        self.refresh();
    }
    pub fn set_preferences(&mut self, preferences: Preferences) -> bool {
        if preferences == self.preferences {
            return false;
        }
        self.preferences = preferences;
        // Reapply after composition/system policy changes even if the final plan is identical.
        self.windows.clear();
        true
    }
    fn update(&mut self, surface: &str, plan: Plan, apply: impl FnOnce(Plan) -> bool) -> Host {
        if let Some((previous, host)) = self.windows.get(surface) {
            if *previous == plan {
                return *host;
            }
        }
        let applied = apply(plan);
        let host = Host {
            backdrop: if plan.mica && applied { "mica" } else { "none" },
            transparency_allowed: plan.transparency_allowed,
            reduced_motion: plan.reduced_motion,
        };
        self.windows.insert(surface.to_string(), (plan, host));
        host
    }
    pub fn host(&mut self, surface: &str, settings: &Value, window: &WebviewWindow) -> Host {
        let plan = Plan::new(surface, settings, self.preferences);
        self.update(surface, plan, |plan| apply_window(window, surface, plan))
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HWND},
        Graphics::Dwm::{
            DwmExtendFrameIntoClientArea, DwmGetWindowAttribute, DwmIsCompositionEnabled,
            DwmSetWindowAttribute, DWMSBT_MAINWINDOW, DWMSBT_NONE, DWMWA_SYSTEMBACKDROP_TYPE,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
        },
        System::{
            Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
            Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD},
        },
        UI::{
            Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
            Controls::MARGINS,
            WindowsAndMessaging::{
                GetSystemMetrics, SystemParametersInfoW, SM_REMOTESESSION,
                SPI_GETCLIENTAREAANIMATION, SPI_GETHIGHCONTRAST,
            },
        },
    };
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    pub fn preferences() -> Preferences {
        let mut transparency = 1_u32;
        let mut bytes = std::mem::size_of_val(&transparency) as u32;
        let registry = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize").as_ptr(),
                wide("EnableTransparency").as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut transparency as *mut u32).cast(),
                &mut bytes,
            )
        };
        let mut composition = 0_i32;
        let composed =
            unsafe { DwmIsCompositionEnabled(&mut composition) } >= 0 && composition != 0;
        let mut contrast = HIGHCONTRASTW {
            cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
            ..Default::default()
        };
        let contrast_ok = unsafe {
            SystemParametersInfoW(
                SPI_GETHIGHCONTRAST,
                contrast.cbSize,
                (&mut contrast as *mut HIGHCONTRASTW).cast(),
                0,
            )
        } != 0;
        let mut animations = 0_i32;
        let animations_ok = unsafe {
            SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                (&mut animations as *mut i32).cast(),
                0,
            )
        } != 0;
        let mut power: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
        let power_ok = unsafe { GetSystemPowerStatus(&mut power) } != 0;
        Preferences {
            transparency: (registry == ERROR_SUCCESS && transparency == 1)
                || registry == ERROR_FILE_NOT_FOUND,
            composition: composed,
            high_contrast: !contrast_ok || contrast.dwFlags & HCF_HIGHCONTRASTON != 0,
            battery_saver: !power_ok || power.SystemStatusFlag == 1,
            remote: unsafe { GetSystemMetrics(SM_REMOTESESSION) } != 0,
            animations: animations_ok && animations != 0,
        }
    }
    fn set(hwnd: HWND, attribute: u32, value: i32) -> bool {
        (unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute,
                (&value as *const i32).cast(),
                std::mem::size_of_val(&value) as u32,
            )
        }) >= 0
    }
    pub fn backdrop(window: &WebviewWindow) -> Option<i32> {
        let hwnd = window.hwnd().ok()?.0;
        let mut value = 0_i32;
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE as u32,
                (&mut value as *mut i32).cast(),
                std::mem::size_of_val(&value) as u32,
            )
        };
        (result >= 0).then_some(value)
    }
    #[cfg(debug_assertions)]
    pub fn dark(window: &WebviewWindow) -> Option<bool> {
        let hwnd = window.hwnd().ok()?.0;
        let mut value = 0_i32;
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                (&mut value as *mut i32).cast(),
                std::mem::size_of_val(&value) as u32,
            )
        };
        (result >= 0).then_some(value != 0)
    }
    pub fn apply(window: &WebviewWindow, surface: &str, plan: Plan) -> bool {
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let hwnd = hwnd.0;
        let _ = set(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            i32::from(plan.dark),
        );
        if surface != "main" {
            return false;
        }
        let margin = if plan.mica { -1 } else { 0 };
        let margins = MARGINS {
            cxLeftWidth: margin,
            cxRightWidth: margin,
            cyTopHeight: margin,
            cyBottomHeight: margin,
        };
        let extended = unsafe { DwmExtendFrameIntoClientArea(hwnd, &margins) } >= 0;
        let target = if plan.mica && extended {
            DWMSBT_MAINWINDOW
        } else {
            DWMSBT_NONE
        };
        let accepted = set(hwnd, DWMWA_SYSTEMBACKDROP_TYPE as u32, target);
        // Tauri's set_effects only acknowledges scheduling, discarding the native HRESULT.
        // Read the supported DWM attribute back before publishing an effective material.
        let verified = accepted && backdrop(window) == Some(target);
        if plan.mica && !verified {
            let _ = set(hwnd, DWMWA_SYSTEMBACKDROP_TYPE as u32, DWMSBT_NONE);
            let zero = MARGINS {
                cxLeftWidth: 0,
                cxRightWidth: 0,
                cyTopHeight: 0,
                cyBottomHeight: 0,
            };
            unsafe {
                DwmExtendFrameIntoClientArea(hwnd, &zero);
            }
        }
        plan.mica && extended && verified
    }
}
#[cfg(windows)]
pub fn read_preferences() -> Preferences {
    native::preferences()
}
#[cfg(not(windows))]
pub fn read_preferences() -> Preferences {
    Preferences {
        transparency: false,
        composition: false,
        high_contrast: false,
        battery_saver: false,
        remote: false,
        animations: true,
    }
}
#[cfg(windows)]
fn apply_window(window: &WebviewWindow, surface: &str, plan: Plan) -> bool {
    native::apply(window, surface, plan)
}
#[cfg(not(windows))]
fn apply_window(_: &WebviewWindow, _: &str, _: Plan) -> bool {
    false
}
#[cfg(all(windows, debug_assertions))]
pub fn native_backdrop(window: &WebviewWindow) -> Option<i32> {
    native::backdrop(window)
}
#[cfg(all(windows, debug_assertions))]
pub fn native_dark(window: &WebviewWindow) -> Option<bool> {
    native::dark(window)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn normal() -> Preferences {
        Preferences {
            transparency: true,
            composition: true,
            high_contrast: false,
            battery_saver: false,
            remote: false,
            animations: true,
        }
    }
    #[test]
    fn normal_main_allows_existing_glass_and_mini_retains_its_transparent_frame() {
        let settings = json!({"glassIntensity":0.65,"motion":"system"});
        assert!(Plan::new("main", &settings, normal()).transparency_allowed);
        assert!(Plan::new("main", &settings, normal()).mica);
        assert!(!Plan::new("mini", &settings, normal()).mica);
        assert!(Plan::new("mini", &settings, normal()).transparency_allowed);
    }
    #[test]
    fn system_policy_and_glass_off_disable_native_material_without_overwriting_preferences() {
        let settings = json!({"glassIntensity":0.7,"motion":"system"});
        for preferences in [
            Preferences {
                transparency: false,
                ..normal()
            },
            Preferences {
                composition: false,
                ..normal()
            },
            Preferences {
                high_contrast: true,
                ..normal()
            },
            Preferences {
                battery_saver: true,
                ..normal()
            },
            Preferences {
                remote: true,
                ..normal()
            },
        ] {
            let plan = Plan::new("main", &settings, preferences);
            assert!(!plan.transparency_allowed);
            assert!(!plan.mica);
        }
        let off = Plan::new("main", &json!({"glassIntensity":0}), normal());
        assert!(off.transparency_allowed);
        assert!(!off.mica);
    }
    #[test]
    fn theme_and_motion_follow_frozen_settings_for_both_surfaces() {
        let preferences = Preferences {
            animations: false,
            ..normal()
        };
        for surface in ["main", "mini"] {
            let plan = Plan::new(
                surface,
                &json!({"motion":"system","ui":{"main":{"materialTheme":"charcoal"}}}),
                preferences,
            );
            assert!(plan.dark && plan.reduced_motion);
            let plan = Plan::new(
                surface,
                &json!({"motion":"full","background":"blue","ui":{"main":{"materialTheme":"standard"}}}),
                preferences,
            );
            assert!(!plan.dark && !plan.reduced_motion);
            assert!(Plan::new(surface, &json!({"motion":"reduced"}), normal()).reduced_motion);
        }
    }
    #[test]
    fn failed_native_application_reports_none_and_unchanged_samples_do_not_reapply() {
        let mut state = State {
            preferences: normal(),
            windows: HashMap::new(),
            test_preferences: None,
        };
        let plan = Plan::new("main", &json!({}), normal());
        let host = state.update("main", plan, |_| false);
        assert_eq!(host.backdrop, "none");
        assert!(host.transparency_allowed);
        assert_eq!(
            state.update("main", plan, |_| panic!(
                "Position-only update reapplied DWM"
            )),
            host
        );
        assert!(!state.set_preferences(normal()));
        assert!(state.set_preferences(Preferences {
            transparency: false,
            ..normal()
        }));
        assert!(state.windows.is_empty());
        assert!(state.set_preferences(normal()));
        assert_eq!(state.update("main", plan, |_| true).backdrop, "mica");
    }
}
