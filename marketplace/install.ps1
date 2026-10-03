# 多平台 skill 安装器：把 .pi/skills/ 下的 Skill 安装到 Codex / pi 的加载目录
# Created on 2026-10-03
# @author: https://github.com/Linmoqian

# 用法：
#   pwsh marketplace/install.ps1                          # 全部 skill 安装到 ~/.agents/skills/（pi 与 Codex 共享读取）
#   pwsh marketplace/install.ps1 -Skills python-dev,tauri # 只安装指定 skill
#   pwsh marketplace/install.ps1 -Target codex            # 安装到 ~/.codex/skills/（仅 Codex）
#   pwsh marketplace/install.ps1 -Target project          # 安装到当前项目 ./.agents/skills/（随项目走）
#   pwsh marketplace/install.ps1 -List                    # 列出可安装的 skill
#
# 说明：Codex 与 pi 均按 Agent Skills 规范发现 ~/.agents/skills/ 下的 SKILL.md；
#       已存在的同名 skill 目录会被覆盖（幂等重装）。

param(
    [string[]]$Skills = @(),
    [ValidateSet("agents", "codex", "project")]
    [string]$Target = "agents",
    [switch]$List
)

$ErrorActionPreference = "Stop"

# -File 调用时逗号分隔参数会被绑定为单个字符串，统一拆分为数组
$Skills = @($Skills | ForEach-Object { $_ -split "\s*,\s*" } | Where-Object { $_ })

$repoRoot = Split-Path $PSScriptRoot -Parent
$skillsDir = Join-Path $repoRoot ".pi/skills"

if (-not (Test-Path $skillsDir)) {
    Write-Host "[错误] 未找到源目录 $skillsDir"
    exit 1
}

$available = Get-ChildItem $skillsDir -Directory | Where-Object {
    Test-Path (Join-Path $_.FullName "SKILL.md")
} | Sort-Object Name

if ($List) {
    Write-Host "可安装的 skill（$($available.Count) 个，源：$skillsDir）："
    $available | ForEach-Object { Write-Host "  - $($_.Name)" }
    exit 0
}

$destRoot = switch ($Target) {
    "agents"  { Join-Path $HOME ".agents/skills" }
    "codex"   { Join-Path $HOME ".codex/skills" }
    "project" { Join-Path (Get-Location) ".agents/skills" }
}

$selected = if ($Skills.Count -gt 0) {
    $missing = $Skills | Where-Object { $available.Name -notcontains $_ }
    if ($missing) {
        Write-Host "[错误] 不存在的 skill：$($missing -join ', ')；用 -List 查看全部"
        exit 1
    }
    $available | Where-Object { $Skills -contains $_.Name }
}
else { $available }

New-Item -ItemType Directory -Force -Path $destRoot | Out-Null

$installed = @()
foreach ($skill in $selected) {
    $dest = Join-Path $destRoot $skill.Name
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Copy-Item -Recurse $skill.FullName $dest
    $installed += $skill.Name
}

Write-Host "[成功] 已安装 $($installed.Count) 个 skill 到 $destRoot"
$installed | ForEach-Object { Write-Host "  - $_" }
if ($Target -eq "agents") {
    Write-Host "说明：~/.agents/skills/ 同时被 pi 与 Codex 发现；若与项目内 .pi/skills/ 重名，pi 优先加载项目级。"
}
