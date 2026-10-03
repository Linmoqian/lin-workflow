# 多平台 skill 与子代理安装器：把 .pi/skills/ 与 .pi/agents/ 安装到 Codex / pi 的加载目录
# Created on 2026-10-03
# @author: https://github.com/Linmoqian

# 用法：
#   pwsh marketplace/install.ps1                          # 全部 skill 安装到 ~/.agents/skills/（pi 与 Codex 共享读取）
#   pwsh marketplace/install.ps1 -Skills python-dev,tauri # 只安装指定 skill
#   pwsh marketplace/install.ps1 -Target codex            # skill 到 ~/.codex/skills/（仅 Codex）
#   pwsh marketplace/install.ps1 -Target project          # skill 到 ./.agents/skills/（随项目走）
#   pwsh marketplace/install.ps1 -Agents                  # 同时安装子代理：
#                                                          #   Target agents  -> ~/.pi/agent/agents/（pi 原生格式）
#                                                          #   Target codex   -> ~/.codex/agents/（转换为 role TOML）
#                                                          #   Target project -> ./.codex/agents/（转换为 role TOML）
#   pwsh marketplace/install.ps1 -List                    # 列出可安装的 skill 与子代理
#
# 说明：Codex 与 pi 均按 Agent Skills 规范发现 ~/.agents/skills/ 下的 SKILL.md；
#       skill 与子代理均幂等重装（覆盖同名目录/文件）；
#       子代理转换为 Codex role TOML 时做平台文字适配（AGENTS.md 表述、send_message 上报），
#       pi 专属字段（tools/systemPromptMode/inheritProjectContext/inheritSkills）无文件级对应，不迁移。

param(
    [string[]]$Skills = @(),
    [ValidateSet("agents", "codex", "project")]
    [string]$Target = "agents",
    [switch]$Agents,
    [switch]$List
)

$ErrorActionPreference = "Stop"

# -File 调用时逗号分隔参数会被绑定为单个字符串，统一拆分为数组
$Skills = @($Skills | ForEach-Object { $_ -split "\s*,\s*" } | Where-Object { $_ })

$repoRoot = Split-Path $PSScriptRoot -Parent
$skillsDir = Join-Path $repoRoot ".pi/skills"
$agentsDir = Join-Path $repoRoot ".pi/agents"

# pi 子代理 md -> Codex role TOML 转换（格式依据 openai/codex agent-roles 模块源码）
function ConvertTo-CodexAgentToml {
    param([string]$AgentFile)

    $lines = Get-Content $AgentFile -Encoding UTF8
    if ($lines[0] -ne "---") { throw "[错误] $AgentFile 缺少 frontmatter" }

    $name = ""; $description = ""; $aliases = @(); $thinking = ""; $output = ""
    $inAliases = $false
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -eq "---") { $body = ($lines[($i + 1)..($lines.Count - 1)] -join "`n"); break }
        if ($lines[$i] -match "^name:\s*(.+)$") { $name = $Matches[1].Trim(); $inAliases = $false }
        elseif ($lines[$i] -match "^description:\s*(.+)$") { $description = $Matches[1].Trim(); $inAliases = $false }
        elseif ($lines[$i] -match "^aliases:\s*(.*)$") {
            $rest = $Matches[1].Trim()
            if ($rest) { $aliases = $rest -split "\s*,\s*" | Where-Object { $_ } }
            $inAliases = $true
        }
        elseif ($inAliases -and $lines[$i] -match "^\s+-\s+(.+)$") { $aliases += $Matches[1].Trim() }
        elseif ($lines[$i] -match "^thinking:\s*(.+)$") { $thinking = $Matches[1].Trim(); $inAliases = $false }
        elseif ($lines[$i] -match "^output:\s*(.+)$") { $output = $Matches[1].Trim(); $inAliases = $false }
    }

    if (-not $name) { throw "[错误] $AgentFile 缺少 name" }

    # 平台文字适配（单引号字符串：反引号为字面量）
    $body = $body -replace '`CLAUDE\.md`（AGENTS\.md 同源）', 'AGENTS.md'
    $body = $body -replace 'CLAUDE\.md（AGENTS\.md 同源）', 'AGENTS.md'
    $body = $body -replace '`CLAUDE\.md`', 'AGENTS.md'
    $body = $body -replace 'CLAUDE\.md', 'AGENTS.md'
    $body = $body -replace '`AGENTS\.md`（AGENTS\.md 同源）', 'AGENTS.md'
    $body = $body -replace '（AGENTS\.md 同源）', ''
    $body = $body -replace 'contact_supervisor', 'send_message'
    if ($output) { $body += "`n最终交接产出写入文件 $output。" }

    # literal 多行字符串（'''）不处理转义，正文中的反斜杠与引号安全
    $toml = ""
    $toml += "# 由 lin-workflow marketplace 从 .pi/agents/ 转换生成，勿手改；再生成：pwsh marketplace/install.ps1 -Agents -Target codex`n"
    $toml += "name = '$name'`n"
    $toml += "description = '$($description -replace "'", "''")'`n"
    if ($aliases.Count -gt 0) {
        $toml += "nickname_candidates = [" + (($aliases | ForEach-Object { "'$_'" }) -join ", ") + "]`n"
    }
    if ($thinking) {
        # pi thinking 与 Codex reasoning effort 同名档位直接映射；max 映射 xhigh
        $effort = if ($thinking -eq "max") { "xhigh" } else { $thinking }
        $toml += "model_reasoning_effort = '$effort'`n"
    }
    $toml += "developer_instructions = '''`n$body'''"

    return [pscustomobject]@{ Name = $name; Toml = $toml }
}

# ---------- 列清单 ----------
if ($List) {
    Write-Host "可安装的 skill（源：$skillsDir）："
    Get-ChildItem $skillsDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName "SKILL.md") } |
        ForEach-Object { Write-Host "  - $($_.Name)" }
    if (Test-Path $agentsDir) {
        Write-Host "可安装的子代理（源：$agentsDir）："
        Get-ChildItem $agentsDir -Filter *.md | ForEach-Object { Write-Host "  - $($_.BaseName)" }
    }
    exit 0
}

if (-not (Test-Path $skillsDir)) {
    Write-Host "[错误] 未找到源目录 $skillsDir"
    exit 1
}

$available = Get-ChildItem $skillsDir -Directory | Where-Object {
    Test-Path (Join-Path $_.FullName "SKILL.md")
} | Sort-Object Name

# ---------- 安装 skill ----------
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

# ---------- 安装子代理 ----------
if ($Agents) {
    if (-not (Test-Path $agentsDir)) {
        Write-Host "[警告] 未找到 $agentsDir，跳过子代理安装"
        exit 0
    }
    $agentDest = switch ($Target) {
        "agents"  { Join-Path $HOME ".pi/agent/agents"; $piNative = $true }
        "codex"   { Join-Path $HOME ".codex/agents"; $piNative = $false }
        "project" { Join-Path (Get-Location) ".codex/agents"; $piNative = $false }
    }
    New-Item -ItemType Directory -Force -Path $agentDest | Out-Null
    $agentFiles = Get-ChildItem $agentsDir -Filter *.md
    foreach ($f in $agentFiles) {
        $destFile = if ($piNative) {
            Copy-Item -Force $f.FullName (Join-Path $agentDest $f.Name)
            $f.Name
        }
        else {
            $converted = ConvertTo-CodexAgentToml -AgentFile $f.FullName
            $outPath = Join-Path $agentDest "$($converted.Name).toml"
            $converted.Toml | Out-File $outPath -Encoding utf8 -NoNewline
            "$($converted.Name).toml"
        }
        Write-Host "  - $destFile"
    }
    Write-Host "[成功] 已安装 $($agentFiles.Count) 个子代理到 $agentDest$($(if ($piNative) { '' } else { '（Codex role TOML）' }))"
    if (-not $piNative) {
        Write-Host "说明：spawn 时通过 agent_type 引用，例如 agent_type=reviewer；tools 白名单等 pi 专属字段未迁移。"
    }
}
