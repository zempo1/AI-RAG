param([string]$Python = '.venv/Scripts/python.exe', [string]$DependencyDir = '')
$ErrorActionPreference = 'Stop'
$previousPythonPath = $env:PYTHONPATH
Push-Location $PSScriptRoot
try {
    if ($DependencyDir) {
        $resolvedDependencies = (Resolve-Path -LiteralPath $DependencyDir).Path
        $env:PYTHONPATH = $resolvedDependencies + $(if ($previousPythonPath) { ';' + $previousPythonPath } else { '' })
    }
    & $Python start.py
    exit $LASTEXITCODE
} finally {
    $env:PYTHONPATH = $previousPythonPath
    Pop-Location
}
