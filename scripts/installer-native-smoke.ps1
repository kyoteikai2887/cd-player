param([Parameter(Mandatory=$true)][string]$Installer,[string]$PreviousInstaller,[string]$Stage='.cache/installer-core21-final-v2')
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$run=Join-Path $project ('.cache/installer-smoke-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$target=[IO.Path]::GetFullPath((Join-Path $run '应用程序'))
if(-not $target.StartsWith($project+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Install target escapes workspace'}
$product='CD 播放器安装测试'
$identity='local.cdplayer.v1.installer-test.20261004'
$registration='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$identity
$productKey='HKCU:\Software\cdplayer\'+$identity
$profile=[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('ApplicationData')) $identity))
$installerPath=[IO.Path]::GetFullPath($Installer)
$stage=[IO.Path]::GetFullPath($Stage,$project)
if(-not $stage.StartsWith((Join-Path $project '.cache')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Installer stage escapes project cache'}
$testedVersion=(Get-Content -LiteralPath (Join-Path $stage 'bundle-project/package.json') -Raw | ConvertFrom-Json).version
if($testedVersion -ne (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version){throw 'Installer stage does not match current source version'}
$installerRoot=Join-Path $stage 'bundle-project/src-tauri/target/release/bundle/nsis'
if(-not $installerPath.StartsWith($installerRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)-or -not [IO.Path]::GetFileName($installerPath).StartsWith($product+'_')){throw 'Only the isolated installer test artifact is accepted'}
if((Test-Path $registration)-or(Test-Path $productKey)-or(Test-Path $profile)){throw 'Existing installer test state must be reviewed; it will not be overwritten'}
if($PreviousInstaller){
  $previousPath=[IO.Path]::GetFullPath($PreviousInstaller)
  $previousRoot=Join-Path $project '.cache/installer-prev-project/src-tauri/target/release/bundle/nsis'
  if(-not $previousPath.StartsWith($previousRoot,[StringComparison]::OrdinalIgnoreCase)-or [IO.Path]::GetFileName($previousPath)-ne ($product+'_0.4.0-r2.3-core.20_x64-setup.exe')){throw 'Previous installer must be the isolated genuine core.20 fixture'}
}
$webview=Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
if(-not $webview.pv){throw 'This test requires an already installed WebView2; it does not install system prerequisites'}
New-Item -ItemType Directory -Path $run,$profile -Force | Out-Null
$checks=[Collections.Generic.List[object]]::new()
$backend=$null
function Run-Setup([string]$arguments,[string]$setupPath=$installerPath){
  $p=Start-Process -FilePath $setupPath -ArgumentList $arguments -PassThru -WindowStyle Hidden
  if(-not $p.WaitForExit(120000)){throw 'Installer did not finish within two minutes'}
  return $p.ExitCode
}
function Run-Uninstall([switch]$NormalLaunch) {
  $arguments=if($NormalLaunch){'/S'}else{"/S _?=$target"}
  $p=Start-Process -FilePath (Join-Path $target 'uninstall.exe') -ArgumentList $arguments -PassThru -WindowStyle Hidden
  if(-not $p.WaitForExit(120000)){throw 'Uninstaller did not finish within two minutes'}
  if($NormalLaunch){
    # Normal NSIS launch copies itself to TEMP and returns before its child finishes.
    # Verify actual files/registration rather than treating launcher exit as completion.
    $end=[DateTime]::UtcNow.AddSeconds(30)
    while((Test-Path (Join-Path $target 'uninstall.exe'))-or(Test-Path $registration)){
      if([DateTime]::UtcNow-gt$end){throw 'Normal uninstaller child did not remove program files and registration'}
      Start-Sleep -Milliseconds 100
    }
  }
  return $p.ExitCode
}
function Fingerprints([string]$folder){
  $map=@{};foreach($f in Get-ChildItem -LiteralPath $folder -File -Recurse){$map[$f.FullName.Substring($folder.Length+1)]=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash};return $map
}
function Equal-Hashes($a,$b){
  if($a.Count-ne $b.Count){return $false};foreach($k in $a.Keys){if($a[$k]-ne $b[$k]){return $false}};return $true
}
try {
  [IO.File]::WriteAllText((Join-Path $profile 'library.json'),'{"originalSyntheticFixture":true}')
  New-Item -ItemType Directory -Path (Join-Path $profile 'backups') | Out-Null
  [IO.File]::WriteAllText((Join-Path $profile 'backups/saved.json'),'original synthetic backup')
  $original=Fingerprints $profile
  [IO.File]::WriteAllText((Join-Path $profile 'writer.lock'),'original synthetic stale lease')
  $blocked=Run-Setup "/S /NS /D=$target"
  if($blocked-eq 0-or(Test-Path (Join-Path $target 'cd-player-desktop.exe'))){throw 'Stale lease did not block installation'}
  Remove-Item -LiteralPath (Join-Path $profile 'writer.lock')
  $checks.Add(@{name='stale-lease-blocks-install';passed=$true;exitCode=$blocked})
  $first=Run-Setup "/S /NS /D=$target"
  if($first-ne 0-or-not(Test-Path $registration)){throw "First install failed: $first"}
  $exe=Join-Path $target 'cd-player-desktop.exe'
  if((Get-FileHash -LiteralPath $exe).Hash-ne(Get-FileHash -LiteralPath (Join-Path $project 'src-tauri/target/release/cd-player-desktop.exe')).Hash){throw 'Installed exe differs'}
  foreach($name in 'runtime','web','licenses'){
    $expected=Fingerprints (Join-Path $stage $name);$actual=Fingerprints (Join-Path $target $name)
    foreach($k in $expected.Keys){if($expected[$k]-ne $actual[$k]){throw "Installed resource mismatch: $name/$k"}}
    if($name-ne 'licenses'-and$expected.Count-ne$actual.Count){throw "Unexpected installed development file in $name"}
  }
  if(-not(Test-Path (Join-Path $target 'licenses/installer/NSIS-COPYING.txt'))){throw 'Installer license missing'}
  if(-not(Equal-Hashes $original (Fingerprints $profile))){throw 'Install changed synthetic profile'}
  $checks.Add(@{name='fresh-install-exe-resources-licenses-and-profile';passed=$true;exitCode=$first})
  # Start only the installed Node backend, against a workspace-only collection.
  # The release GUI is not started because it selects the real Windows user profile.
  $psi=[Diagnostics.ProcessStartInfo]::new((Join-Path $target 'runtime/node.exe'))
  foreach($argument in @((Join-Path $target 'runtime/server.mjs'),'--data',(Join-Path $run 'backend-data'),'--assets',(Join-Path $target 'web'),'--picker',(Join-Path $target 'runtime/file-picker.exe'))){$psi.ArgumentList.Add($argument)}
  $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $backend=[Diagnostics.Process]::Start($psi)
  $err=$backend.StandardError.ReadToEndAsync()
  $line=$backend.StandardOutput.ReadLineAsync()
  if(-not $line.Wait(20000)){throw 'Installed backend startup timed out'}
  $frame=$line.Result|ConvertFrom-Json
  if($frame.startupError-or$frame.origin-notmatch '^http://127\.0\.0\.1:[0-9]+$'){throw 'Installed backend did not become ready'}
  $response=Invoke-WebRequest ($frame.origin+'/desktop.html') -UseBasicParsing
  if($response.StatusCode-ne 200){throw 'Installed web assets not served'}
  $checks.Add(@{name='installed-runtime-serves-production-web';passed=$true})
  $installed=Fingerprints $target
  $blocked=Run-Setup "/S /NS /UPDATE /D=$target"
  if($blocked-eq 0-or$backend.HasExited-or-not(Equal-Hashes $installed (Fingerprints $target))){throw 'In-use update changed files or killed backend'}
  $checks.Add(@{name='in-use-update-refused-without-termination';passed=$true;exitCode=$blocked})
  $blocked=Run-Uninstall
  if($blocked-eq 0-or$backend.HasExited-or-not(Equal-Hashes $installed (Fingerprints $target))){throw 'In-use uninstall changed files or killed backend'}
  $checks.Add(@{name='in-use-uninstall-refused-without-termination';passed=$true;exitCode=$blocked})
  $backend.StandardInput.WriteLine('shutdown');$backend.StandardInput.Flush()
  if(-not$backend.WaitForExit(10000)-or$backend.ExitCode-ne 0){throw 'Installed backend did not exit cleanly'}
  [IO.File]::WriteAllText((Join-Path $run 'backend.log'),$err.Result)
  $backend.Dispose();$backend=$null
  if(Test-Path (Join-Path $run 'backend-data/writer.lock')){throw 'Installed backend retained lease'}
  $checks.Add(@{name='installed-backend-normal-exit-releases-lease';passed=$true})
  $again=Run-Setup "/S /NS /UPDATE /D=$target"
  if($again-ne 0-or-not(Equal-Hashes $original (Fingerprints $profile))){throw 'Same-version update lost profile'}
  $checks.Add(@{name='same-version-update-keeps-profile';passed=$true;exitCode=$again})
  $removed=Run-Uninstall
  if($removed-ne 0-or(Test-Path $exe)-or(Test-Path $registration)-or(Test-Path $productKey)-or-not(Equal-Hashes $original (Fingerprints $profile))){throw 'Uninstall did not retain profile and remove program registration'}
  $checks.Add(@{name='uninstall-keeps-profile-backup-removes-only-program';passed=$true;exitCode=$removed})
  if($PreviousInstaller){
    $old=Run-Setup "/S /NS /D=$target" $previousPath
    $oldExe=Join-Path $project '../output/development/CD_Player_R2_3_core20/CD播放器.exe'
    if($old-ne 0-or(Get-FileHash -LiteralPath $exe).Hash-ne(Get-FileHash -LiteralPath $oldExe).Hash-or-not(Equal-Hashes $original (Fingerprints $profile))){throw 'Genuine core.20 install failed'}
    $checks.Add(@{name='genuine-core20-install-retains-profile';passed=$true;exitCode=$old})
    $upgraded=Run-Setup "/S /NS /UPDATE /D=$target"
    if($upgraded-ne 0-or(Get-FileHash -LiteralPath $exe).Hash-ne(Get-FileHash -LiteralPath (Join-Path $project 'src-tauri/target/release/cd-player-desktop.exe')).Hash-or-not(Equal-Hashes $original (Fingerprints $profile))){throw "Core.20 to $testedVersion upgrade failed"}
    $checks.Add(@{name='genuine-core20-to-current-upgrade-keeps-profile';passed=$true;exitCode=$upgraded})
    $before=Fingerprints $target
    $downgrade=Run-Setup "/S /NS /UPDATE /D=$target" $previousPath
    if($downgrade-eq 0-or-not(Equal-Hashes $before (Fingerprints $target))-or-not(Equal-Hashes $original (Fingerprints $profile))){throw 'Downgrade was not blocked'}
    $checks.Add(@{name='current-to-core20-downgrade-refused';passed=$true;exitCode=$downgrade})
    [IO.File]::WriteAllText((Join-Path $target '留存文件.txt'),'original synthetic untracked file')
    $removed=Run-Uninstall -NormalLaunch
    if($removed-ne 0-or(Test-Path $exe)-or(Test-Path $registration)-or(Test-Path $productKey)-or-not(Equal-Hashes $original (Fingerprints $profile))){throw 'Final uninstall after upgrade lost profile'}
    $checks.Add(@{name='upgraded-program-uninstall-keeps-profile';passed=$true;exitCode=$removed})
    $remaining=@(Get-ChildItem -LiteralPath $target -File -Recurse)
    if($remaining.Count-ne 1-or$remaining[0].Name-ne '留存文件.txt'-or(Get-Content -LiteralPath $remaining[0].FullName -Raw)-ne 'original synthetic untracked file'){throw 'Normal uninstall retained program files or removed untracked file'}
    $checks.Add(@{name='normal-uninstall-removes-self-retains-untracked-file';passed=$true})
  }
  $report=@{passed=$true;prototypeVersion=$testedVersion;output=$run;checks=$checks;crossVersionUpgradeAndDowngradeChecked=[bool]$PreviousInstaller;installerTestIdentity=$identity;isolatedRegistration=$true;realDefaultCollectionModified=$false;installedReleaseGuiStarted=$false;physicalAudioOrOnlineUsed=$false;limits=@('WebView2 was already installed; missing-runtime bootstrapper remains','Silent paths only; interactive pages and Windows signing remain','Installed backend served assets; release GUI against a real user profile was not launched','Synthetic profile bytes retained; no release-GUI-driven schema migration was tested')}
  $report|ConvertTo-Json -Depth 7|Set-Content -LiteralPath (Join-Path $run 'report.json') -Encoding utf8
  Write-Output ($report|ConvertTo-Json -Depth 7 -Compress)
}catch{
  @{passed=$false;error=$_.Exception.Message;checks=$checks}|ConvertTo-Json -Depth 7|Set-Content -LiteralPath (Join-Path $run 'failure.json') -Encoding utf8
  throw
}finally{
  if($backend-and-not$backend.HasExited){$backend.StandardInput.WriteLine('shutdown');$backend.StandardInput.Flush();if(-not$backend.WaitForExit(10000)){$backend.Kill();$backend.WaitForExit()};$backend.Dispose()}
  # Keep a failed run for inspection. Only remove this explicitly named test profile after all checks.
  if(Test-Path (Join-Path $run 'report.json')){
    $expected=[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('ApplicationData')) $identity))
    if($profile-ne$expected-or[IO.Path]::GetFileName($profile)-ne$identity){throw 'Profile cleanup target mismatch'}
    Remove-Item -LiteralPath $profile -Recurse
  }
}
