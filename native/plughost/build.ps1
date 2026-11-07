# Builds the x64 Windows VST3 host and keeps it with its licences in the cache.
. "$PSScriptRoot\..\windows.ps1"
$build = Join-Path $PSScriptRoot 'build-windows'
$out = Join-Path $cache 'plughost'
& cmake -S $PSScriptRoot -B $build -A x64
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& cmake --build $build --config Release --target plughost --parallel
if ($LASTEXITCODE) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item "$build\Release\plughost.exe" "$out\plughost.exe" -Force
Copy-Item "$build\_deps\vst3sdk-src\LICENSE.txt" "$out\vst3sdk-LICENSE.txt" -Force
Copy-Item "$build\_deps\json-src\LICENSE.MIT" "$out\json-LICENSE.txt" -Force
Write-Output "plughost: $out\plughost.exe"
