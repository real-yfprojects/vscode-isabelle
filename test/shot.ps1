# Capture only the VS Code window showing Render.thy (a window this test launched),
# not the whole desktop.
param([string]$OutFile)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$proc = Get-Process -Name Code -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like '*Render.thy*' } | Select-Object -First 1
if (-not $proc) {
  Write-Output "NO_WINDOW: no Code process titled *Render.thy*"
  Get-Process -Name Code -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle } | ForEach-Object { Write-Output ("  title: " + $_.MainWindowTitle) }
  exit 1
}

Write-Output ("window: " + $proc.MainWindowTitle)
[void][Win]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 900

$r = New-Object Win+RECT
[void][Win]::GetWindowRect($proc.MainWindowHandle, [ref]$r)
$w = $r.R - $r.L
$h = $r.B - $r.T
Write-Output "rect: ${w}x${h} at ($($r.L),$($r.T))"

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $h))
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved: $OutFile"
