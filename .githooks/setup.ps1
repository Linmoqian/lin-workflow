$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel).Trim()
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
    throw 'Unable to resolve the Git repository root.'
}

Set-Location -LiteralPath $repoRoot
git config --local core.hooksPath .githooks
Write-Output '[OK] Git hooks enabled: .githooks'
