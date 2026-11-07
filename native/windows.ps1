# Shared Windows build prerequisites: Visual Studio's Desktop development with C++ workload, including CMake.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($vs) { $env:PATH = (Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin') + ';' + $env:PATH }
    }
}
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) { throw 'Install Visual Studio Build Tools with Desktop development with C++ and CMake.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Install Git for Windows and reopen the terminal.' }
$cache = if ($env:EPHEMERIS_CACHE) { $env:EPHEMERIS_CACHE } else { Join-Path $HOME '.cache\ephemeris' }
