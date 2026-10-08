use std::path::Path;

// Stable, case-insensitive key for the canonical Windows data path, independent of exe version.
fn instance_name(directory: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in directory.replace('/', "\\").to_lowercase().bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    format!("Global\\CDPlayerV1-{hash:016x}")
}

#[cfg(windows)]
pub struct InstanceGuard(usize);
#[cfg(windows)]
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _); }
    }
}
#[cfg(windows)]
pub fn acquire_instance(directory: &Path) -> Result<InstanceGuard, Box<dyn std::error::Error>> {
    use windows_sys::Win32::{Foundation::{GetLastError, SetLastError, ERROR_ALREADY_EXISTS, CloseHandle},
        System::Threading::CreateMutexW};
    std::fs::create_dir_all(directory)?;
    let canonical = std::fs::canonicalize(directory)?;
    let name: Vec<u16> = instance_name(&dunce::simplified(&canonical).to_string_lossy())
        .encode_utf16().chain(Some(0)).collect();
    // The existence of the named kernel object is the guard. There is no thread ownership;
    // Windows closes the handle even if the parent is terminated, so it cannot leave a file lock.
    let handle = unsafe { SetLastError(0); CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() { return Err(std::io::Error::last_os_error().into()); }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle); }
        return Err("播放器已在运行，请从任务栏托盘恢复主窗口。不能同时打开多个版本。".into());
    }
    Ok(InstanceGuard(handle as usize))
}

#[cfg(not(windows))]
pub struct InstanceGuard;
#[cfg(not(windows))]
pub fn acquire_instance(_: &Path) -> Result<InstanceGuard, Box<dyn std::error::Error>> {
    Ok(InstanceGuard)
}

pub fn report_error(error: &str) {
    let message = format!("CD 播放器未能启动。\n\n{error}\n\n收藏和音乐文件未被清空。若播放器还在后台，请从托盘恢复。\n请保留完整的 runtime、web 文件夹后重试。");
    eprintln!("{message}");
    #[cfg(windows)] {
        if let Some(roaming) = std::env::var_os("APPDATA") {
            let folder = std::path::PathBuf::from(roaming).join("local.cdplayer.v1");
            let _ = std::fs::create_dir_all(&folder);
            let _ = std::fs::write(folder.join("last-startup-error.txt"), &message);
        }
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "CD 播放器 · 启动提示".encode_utf16().chain(Some(0)).collect();
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn instance_identity_ignores_path_case_and_separators() {
        assert_eq!(instance_name("C:/Users/音乐/Data"), instance_name("c:\\users\\音乐\\data"));
        assert_ne!(instance_name("C:/DataA"), instance_name("C:/DataB"));
    }
    #[cfg(windows)]
    #[test]
    fn guard_blocks_duplicates_and_releases_on_drop() {
        let directory = std::env::temp_dir().join(format!("cd-player-instance-{}", uuid::Uuid::new_v4()));
        let guard = acquire_instance(&directory).unwrap();
        assert!(acquire_instance(&directory).is_err());
        drop(guard);
        drop(acquire_instance(&directory).unwrap());
        std::fs::remove_dir(&directory).unwrap();
    }
}
