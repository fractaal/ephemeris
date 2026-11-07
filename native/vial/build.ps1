# Builds Vial's pinned source as a Windows x64 VST3, using MSVC and the Windows SDK (no IPP or Firebase).
. "$PSScriptRoot\..\windows.ps1"
$src = Join-Path $cache 'vital-src'
# One pin for every platform.
$commit = [regex]::Match((Get-Content "$PSScriptRoot\build.sh" -Raw), '(?m)^commit=([0-9a-f]+)').Groups[1].Value
if (-not $commit) { throw 'No Vial source commit in build.sh' }
if (-not (Test-Path "$src\.git")) {
    & git clone https://github.com/mtytel/vital.git $src
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
& git -C $src checkout -q -f $commit
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& git -C $src apply "$PSScriptRoot\vital.patch"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$build = Join-Path $PSScriptRoot 'build-windows'
& cmake -S $PSScriptRoot -B $build -A x64 "-DVITAL_SOURCE_DIR=$src"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
# The unity translation units are large; two compilers fit in an 8 GB build machine.
& cmake --build $build --config Release --parallel 2
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$out = Join-Path $cache 'plugins\Vial.vst3\Contents\x86_64-win'
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item "$build\Release\Vial.vst3" "$out\Vial.vst3" -Force
Write-Output "Vial: $cache\plugins\Vial.vst3"
