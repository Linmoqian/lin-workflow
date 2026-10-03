# 仓库自检：skill frontmatter 校验、skill 间相对链接检查、多平台转换冒烟
# Created on 2026-10-03
# @author: https://github.com/Linmoqian

# 用法：pwsh tools/check-skills.ps1（或 pnpm test）
# 校验项：
#   1. 每个 .pi/skills/*/SKILL.md 存在且 frontmatter 合法（name 格式、目录一致、description 非空）
#   2. SKILL.md 内 ../xxx/SKILL.md 相对链接全部指向存在的文件
#   3. 子代理 .pi/agents/*.md 转换 Codex TOML 冒烟（生成到临时目录并做基础结构断言）

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$skillsDir = Join-Path $repoRoot ".pi/skills"
$agentsDir = Join-Path $repoRoot ".pi/agents"
$fail = 0

# ---------- 1. skill frontmatter ----------
$skillCount = 0
Get-ChildItem $skillsDir -Directory | ForEach-Object {
    $name = $_.Name
    $f = Join-Path $_.FullName "SKILL.md"
    if (-not (Test-Path $f)) { Write-Host "[错误] $name 缺少 SKILL.md"; $fail++; return }
    $skillCount++
    $fmName = (Select-String -Path $f -Pattern "^name:\s*(.+)$" | Select-Object -First 1).Matches[0].Groups[1].Value.Trim()
    if ($fmName -ne $name) { Write-Host "[错误] $name 目录与 frontmatter name 不一致: $fmName"; $fail++ }
    if ($fmName -notmatch "^[a-z][a-z0-9-]*$" -or $fmName -match "--") { Write-Host "[错误] $name 非法名称: $fmName"; $fail++ }
    $desc = Select-String -Path $f -Pattern "^description:" | Select-Object -First 1
    if (-not $desc) { Write-Host "[错误] $name 缺少 description"; $fail++ }
}
Write-Host "[成功] skill frontmatter 校验：$skillCount 个"

# ---------- 2. 相对链接 ----------
Get-ChildItem $skillsDir -Directory | ForEach-Object {
    $skillDir = $_.FullName
    Select-String -Path (Join-Path $skillDir "SKILL.md") -Pattern "\]\((\.\./[a-z-]+/SKILL\.md)\)" -AllMatches | ForEach-Object {
        $rel = $_.Matches[0].Groups[1].Value
        if (-not (Test-Path (Join-Path $skillDir $rel))) {
            Write-Host "[错误] $($_.Filename) -> $rel 不存在"; $fail++
        }
    }
}
Write-Host "[成功] skill 相对链接检查完成"

# ---------- 3. 子代理转换冒烟 ----------
if (Test-Path $agentsDir) {
    $tmp = Join-Path $env:TEMP "lin-workflow-check-$PID"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        & (Join-Path $repoRoot "marketplace/install.ps1") -Target project -Agents -Skills api-documentation *> $null
        $tomlCount = (Get-ChildItem (Join-Path $repoRoot ".codex/agents") -Filter *.toml -ErrorAction SilentlyContinue).Count
        $mdCount = (Get-ChildItem (Join-Path $repoRoot ".claude/agents") -Filter *.md -ErrorAction SilentlyContinue).Count
        Remove-Item -Recurse -Force (Join-Path $repoRoot ".codex"), (Join-Path $repoRoot ".claude"), (Join-Path $repoRoot ".agents"), (Join-Path $repoRoot ".dsh") -ErrorAction SilentlyContinue
        $agentCount = (Get-ChildItem $agentsDir -Filter *.md).Count
        if ($tomlCount -eq $agentCount -and $mdCount -eq $agentCount) {
            Write-Host "[成功] 子代理转换冒烟：TOML $tomlCount 个、Claude md $mdCount 个"
        }
        else { Write-Host "[错误] 转换数量不符：TOML $tomlCount / md $mdCount / 源 $agentCount"; $fail++ }
    }
    finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

# ---------- 结果 ----------
if ($fail -gt 0) { Write-Host "[错误] 共 $fail 项检查失败"; exit 1 }
Write-Host "[成功] 全部检查通过"
