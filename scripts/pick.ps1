param([ValidateSet('folder','lyrics','cover')][string]$Kind)
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($Kind -eq 'folder') {
  $picker = [System.Windows.Forms.FolderBrowserDialog]::new()
  $picker.Description = '选择 CD 音乐文件夹（只读取，不修改原文件）'
  $picker.ShowNewFolderButton = $false
  if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.SelectedPath) }
} else {
  $picker = [System.Windows.Forms.OpenFileDialog]::new()
  $picker.Filter = if ($Kind -eq 'lyrics') { '歌词文件|*.lrc;*.txt' } else { '封面图片|*.jpg;*.jpeg;*.png;*.webp' }
  if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.FileName) }
}
$picker.Dispose()
