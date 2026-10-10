param(
    [Parameter(Mandatory=$true)][int]$TargetProcessId,
    [Parameter(Mandatory=$true)][ValidateRange(900,6000)][int]$ClientWidth,
    [Parameter(Mandatory=$true)][ValidateRange(600,4000)][int]$ClientHeight
)
$ErrorActionPreference = 'Stop'
# Operate only on the debug child launched by crystal-native-smoke.mjs.
$expected = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src-tauri/target/debug/cd-player-desktop.exe'))
$owned = Get-Process -Id $TargetProcessId -ErrorAction Stop
if ($owned.HasExited -or $owned.Path -ne $expected) { throw 'Expected isolated debug process not found' }
$command = (Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId").CommandLine
$dataRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.cache/v1-1-native-'))
if ($command -notmatch '--smoke-manual' -or $command -notmatch '--smoke-data' -or
    $command.IndexOf($dataRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw 'Process is not the isolated crystal check'
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CrystalSmokeWindow {
    public delegate bool EnumProc(IntPtr h, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
    public static IntPtr FindMain(int pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h,d) => {
            uint owner; GetWindowThreadProcessId(h,out owner);
            Rect r;
            if (owner==pid && IsWindowVisible(h) && GetClientRect(h,out r) && r.R-r.L>700) {
                if (found!=IntPtr.Zero) throw new InvalidOperationException("Multiple main windows");
                found=h;
            }
            return true;
        },IntPtr.Zero);
        return found;
    }
}
'@
[CrystalSmokeWindow]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$handle = [CrystalSmokeWindow]::FindMain($TargetProcessId)
if ($handle -eq [IntPtr]::Zero) { throw 'Visible owned main window not found' }
$inner = New-Object CrystalSmokeWindow+Rect
$outer = New-Object CrystalSmokeWindow+Rect
if (-not [CrystalSmokeWindow]::GetClientRect($handle,[ref]$inner) -or
    -not [CrystalSmokeWindow]::GetWindowRect($handle,[ref]$outer)) { throw 'Unable to inspect owned window' }
$width = $ClientWidth + ($outer.R-$outer.L) - ($inner.R-$inner.L)
$height = $ClientHeight + ($outer.B-$outer.T) - ($inner.B-$inner.T)
# NOZORDER | NOACTIVATE: change this test window only, without stealing focus.
if (-not [CrystalSmokeWindow]::SetWindowPos($handle,[IntPtr]::Zero,$outer.L,$outer.T,$width,$height,0x14)) {
    throw "Window resize failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
