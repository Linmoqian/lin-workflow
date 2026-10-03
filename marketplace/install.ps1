# 多平台 skill 与子代理安装器：把 .pi/skills/ 与 .pi/agents/ 安装到各 agent 平台加载目录
# Created on 2026-10-03
# @author: https://github.com/Linmoqian

# 用法（-Target 可多选，逗号分隔）：
#   pwsh marketplace/install.ps1                                   # 全部 skill -> ~/.agents/skills/（pi 与 Codex 共享）
#   pwsh marketplace/install.ps1 -Target claude,codex -Agents      # 多平台：skill + 子代理
#   pwsh marketplace/install.ps1 -Target pi -Agents                # pi 原生：~/.pi/agent/{skills,agents}
#   pwsh marketplace/install.ps1 -Target dsh                       # ~/.dsh/skills/
#   pwsh marketplace/install.ps1 -Target project -Agents           # 当前项目：.agents/ .claude/ .dsh/ skill
#                                                                  #  + .codex/agents(TOML) + .claude/agents(md)
#   pwsh marketplace/install.ps1 -Skills python-dev,tauri          # 按名单安装
#   pwsh marketplace/install.ps1 -List                             # 列出可用内容
#
# 平台目录（官方文档与 Agent Skills 规范）：
#   agents  用户级 ~/.agents/skills/（pi、Codex 均读取；子代理无对应，配 -Agents 时装 pi 原生到 ~/.pi/agent/agents/）
#   codex   ~/.codex/skills/ + ~/.codex/agents/*.toml（role TOML，spawn 用 agent_type=<name>）
#   claude  ~/.claude/skills/ + ~/.claude/agents/*.md（工具名映射 pi->Claude）
#   dsh     ~/.dsh/skills/（子代理机制无公开契约，不安装）
#   pi      ~/.pi/agent/skills/ + ~/.pi/agent/agents/（原生格式直装）
#   project 当前项目各平台项目级目录（.agents/.claude/.dsh skill + .codex/.claude agents）
#
# 说明：skill 与子代理均幂等重装；转换做平台文字适配；pi 专属字段（tools 白名单等）在 Codex 不迁移，
#       Claude 侧仅映射同名工具并丢弃无对应项（pwsh_exec/test_pilot/contact_supervisor 等）。

param(
    [string[]]$Skills = @(),
    [string[]]$Target = @("agents"),
    [switch]$Agents,
    [switch]$List
)

$ErrorActionPreference = "Stop"

# -File 调用时逗号分隔参数会被绑定为单个字符串，统一拆分
$Skills = @($Skills | ForEach-Object { $_ -split "\s*,\s*" } | Where-Object { $_ })
$Target = @($Target | ForEach-Object { $_ -split "\s*,\s*" } | Where-Object { $_ })
$validTargets = @("agents", "codex", "claude", "dsh", "pi", "project")
$bad = $Target | Where-Object { $validTargets -notcontains $_ }
if ($bad) {
    Write-Host "[错误] 未知目标：$($bad -join ', ')；可选：$($validTargets -join ', ')"
    exit 1
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$skillsDir = Join-Path $repoRoot ".pi/skills"
$agentsDir = Join-Path $repoRoot ".pi/agents"

# 从 pi 子代理 md 解析 frontmatter 与正文
function Get-PiAgent {
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
    return [pscustomobject]@{ Name = $name; Description = $description; Aliases = $aliases; Thinking = $thinking; Output = $output; Body = $body }
}

# 平台文字适配（Codex/Claude 共用：AGENTS.md 表述）
function Get-AdaptedBody {
    param([string]$Body, [string]$Output)
    $b = $Body
    $b = $b -replace '`CLAUDE\.md`（AGENTS\.md 同源）', 'AGENTS.md'
    $b = $b -replace 'CLAUDE\.md（AGENTS\.md 同源）', 'AGENTS.md'
    $b = $b -replace '`CLAUDE\.md`', 'AGENTS.md'
    $b = $b -replace 'CLAUDE\.md', 'AGENTS.md'
    $b = $b -replace '`AGENTS\.md`（AGENTS\.md 同源）', 'AGENTS.md'
    $b = $b -replace '（AGENTS\.md 同源）', ''
    if ($Output) { $b += "`n最终交接产出写入文件 $Output。" }
    return $b
}

# pi md -> Codex role TOML（格式依据 openai/codex agent-roles 源码）
function ConvertTo-CodexAgentToml {
    param([string]$AgentFile)
    $a = Get-PiAgent $AgentFile
    $body = Get-AdaptedBody $a.Body $a.Output
    $body = $body -replace 'contact_supervisor', 'send_message'

    $toml = ""
    $toml += "# 由 lin-workflow marketplace 从 .pi/agents/ 转换生成，勿手改；再生成：pwsh marketplace/install.ps1 -Agents -Target codex`n"
    $toml += "name = '$($a.Name)'`n"
    $toml += "description = '$($a.Description -replace "'", "''")'`n"
    if ($a.Aliases.Count -gt 0) {
        $toml += "nickname_candidates = [" + (($a.Aliases | ForEach-Object { "'$_'" }) -join ", ") + "]`n"
    }
    if ($a.Thinking) {
        $effort = if ($a.Thinking -eq "max") { "xhigh" } else { $a.Thinking }
        $toml += "model_reasoning_effort = '$effort'`n"
    }
    $toml += "developer_instructions = '''`n$body'''"
    return [pscustomobject]@{ Name = $a.Name; Content = $toml; Ext = "toml" }
}

# pi tools -> Claude 工具名映射；无对应的丢弃
$claudeToolMap = @{
    "read" = "Read"; "grep" = "Grep"; "find" = "Glob"; "ls" = "LS"; "bash" = "Bash"
    "edit" = "Edit"; "write" = "Write"; "web_search" = "WebSearch"; "fetch_content" = "WebFetch"
}

# pi md -> Claude Code agents md（格式依据 code.claude.com/docs/en/sub-agents）
function ConvertTo-ClaudeAgentMd {
    param([string]$AgentFile)
    $a = Get-PiAgent $AgentFile
    $body = Get-AdaptedBody $a.Body $a.Output

    # contact_supervisor 无 Claude 对应：句子级改写 + 兜底
    $body = $body -replace '暂停并通过 `contact_supervisor`（reason 用 need_decision）上报，等待回复后再继续', '暂停执行，在最终回复中列出需要主代理决策的事项，由主代理处理后继续'
    $body = $body -replace '通过 `contact_supervisor`（reason 用 need_decision）上报并等待回复，不要擅自决定', '暂停执行，在最终回复中列出需要主代理决策的事项，不要擅自决定'
    $body = $body -replace '通过 `contact_supervisor`（reason 用 need_decision）上报，等待回复后再继续', '暂停执行，在最终回复中列出需要主代理决策的事项，由主代理处理后继续'
    $body = $body -replace '用 `contact_supervisor`（reason 用 need_decision）向主 agent 询问，而非臆测', '在最终回复中列出需主 agent 澄清的问题，而非臆测'
    $body = $body -replace '`contact_supervisor`（reason 用 need_decision）', '主代理决策上报'
    $body = $body -replace 'contact_supervisor', '主代理决策上报'

    # 工具白名单映射
    $raw = (Select-String -Path $AgentFile -Pattern "^tools:\s*(.+)$").Matches[0].Groups[1].Value
    $tools = @($raw -split "\s*,\s*" | ForEach-Object { $claudeToolMap[$_.Trim()] } | Where-Object { $_ })

    $md = ""
    $md += "---`n"
    $md += "name: $($a.Name)`n"
    $md += "description: $($a.Description)`n"
    if ($tools.Count -gt 0) { $md += "tools: $($tools -join ', ')`n" }
    $md += "---`n"
    $md += "# 由 lin-workflow marketplace 从 .pi/agents/ 转换生成，勿手改；再生成：pwsh marketplace/install.ps1 -Agents -Target claude`n`n"
    $md += $body
    return [pscustomobject]@{ Name = $a.Name; Content = $md; Ext = "md" }
}

# ---------- 列清单 ----------
if ($List) {
    Write-Host "可安装的 skill（源：$skillsDir）："
    Get-ChildItem $skillsDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName "SKILL.md") } |
        ForEach-Object { Write-Host "  - $($_.Name)" }
    if (Test-Path $agentsDir) {
        Write-Host "可安装的子代理（源：$agentsDir；dsh 无子代理机制不安装）："
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

$selected = if ($Skills.Count -gt 0) {
    $missing = $Skills | Where-Object { $available.Name -notcontains $_ }
    if ($missing) {
        Write-Host "[错误] 不存在的 skill：$($missing -join ', ')；用 -List 查看全部"
        exit 1
    }
    $available | Where-Object { $Skills -contains $_.Name }
}
else { $available }

# ---------- skill 安装目标 ----------
# target -> skill 目录列表（project 模式装齐各平台项目级目录）
$skillDestMap = [ordered]@{
    "agents"  = @((Join-Path $HOME ".agents/skills"))
    "codex"   = @((Join-Path $HOME ".codex/skills"))
    "claude"  = @((Join-Path $HOME ".claude/skills"))
    "dsh"     = @((Join-Path $HOME ".dsh/skills"))
    "pi"      = @((Join-Path $HOME ".pi/agent/skills"))
    "project" = @(
        (Join-Path (Get-Location) ".agents/skills"),
        (Join-Path (Get-Location) ".claude/skills"),
        (Join-Path (Get-Location) ".dsh/skills")
    )
}

foreach ($t in $Target) {
    foreach ($dest in $skillDestMap[$t]) {
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        foreach ($skill in $selected) {
            $d = Join-Path $dest $skill.Name
            if (Test-Path $d) { Remove-Item -Recurse -Force $d }
            Copy-Item -Recurse $skill.FullName $d
        }
        Write-Host "[成功] [$t] 已安装 $($selected.Count) 个 skill 到 $dest"
    }
}

# ---------- 子代理安装 ----------
if ($Agents) {
    if (-not (Test-Path $agentsDir)) {
        Write-Host "[警告] 未找到 $agentsDir，跳过子代理安装"
        exit 0
    }
    $agentFiles = Get-ChildItem $agentsDir -Filter *.md

    foreach ($t in $Target) {
        # target -> @{ dest; converter }（null converter = 原样复制；dsh 无机制跳过）
        $plan = switch ($t) {
            "agents"  { @{ Dest = Join-Path $HOME ".pi/agent/agents"; Converter = $null } }
            "codex"   { @{ Dest = Join-Path $HOME ".codex/agents"; Converter = ${function:ConvertTo-CodexAgentToml} } }
            "claude"  { @{ Dest = Join-Path $HOME ".claude/agents"; Converter = ${function:ConvertTo-ClaudeAgentMd} } }
            "pi"      { @{ Dest = Join-Path $HOME ".pi/agent/agents"; Converter = $null } }
            "project" { @{ Dest = $null; Converter = $null } }
        }
        if ($t -eq "dsh") { Write-Host "[跳过] [dsh] 无公开子代理契约，不安装"; continue }

        if ($t -eq "project") {
            # 项目级：Codex TOML + Claude md 各装一份
            foreach ($pair in @(
                @{ Dest = Join-Path (Get-Location) ".codex/agents"; Converter = ${function:ConvertTo-CodexAgentToml} },
                @{ Dest = Join-Path (Get-Location) ".claude/agents"; Converter = ${function:ConvertTo-ClaudeAgentMd} }
            )) {
                New-Item -ItemType Directory -Force -Path $pair.Dest | Out-Null
                foreach ($f in $agentFiles) {
                    if ($pair.Converter) {
                        $conv = & $pair.Converter $f.FullName
                        $conv.Content | Out-File (Join-Path $pair.Dest "$($conv.Name).$($conv.Ext)") -Encoding utf8 -NoNewline
                    }
                    else { Copy-Item -Force $f.FullName (Join-Path $pair.Dest $f.Name) }
                }
                Write-Host "[成功] [$t] 已安装 $($agentFiles.Count) 个子代理到 $($pair.Dest)"
            }
            continue
        }

        New-Item -ItemType Directory -Force -Path $plan.Dest | Out-Null
        foreach ($f in $agentFiles) {
            if ($plan.Converter) {
                $conv = & $plan.Converter $f.FullName
                $conv.Content | Out-File (Join-Path $plan.Dest "$($conv.Name).$($conv.Ext)") -Encoding utf8 -NoNewline
            }
            else { Copy-Item -Force $f.FullName (Join-Path $plan.Dest $f.Name) }
        }
        $form = if ($plan.Converter) { "（转换格式）" } else { "（pi 原生）" }
        Write-Host "[成功] [$t] 已安装 $($agentFiles.Count) 个子代理到 $($plan.Dest)$form"
    }
}
