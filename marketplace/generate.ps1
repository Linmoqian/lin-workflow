# 生成 pi 插件市场的 skills.json 索引
# Created on 2026-10-03
# @author: https://github.com/Linmoqian

# 用法：pwsh marketplace/generate.ps1
# 扫描 .pi/skills/*/SKILL.md 的 frontmatter（name、description），
# 叠加手工分类映射，输出 marketplace/skills.json 供 index.html 渲染。

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$skillsDir = Join-Path $repoRoot ".pi/skills"
$outFile = Join-Path $PSScriptRoot "skills.json"

# 手工分类映射：skill 名 -> 分类；未列出的归入「其他」
$categoryMap = @{
    "project-engineering"   = "工程流程"
    "verification"          = "工程流程"
    "code-review"           = "工程流程"
    "git-workflow"          = "工程流程"
    "github-workflow"       = "工程流程"
    "github-wiki"           = "工程流程"
    "dependency-management" = "工程流程"
    "file-organization"     = "工程流程"
    "dev-log"               = "工程流程"
    "cli-conventions"       = "工程流程"
    "python-dev"            = "语言与平台"
    "rust-dev"              = "语言与平台"
    "cpp-dev"               = "语言与平台"
    "frontend-dev"          = "语言与平台"
    "harmonyos-dev"         = "语言与平台"
    "tauri"                 = "语言与平台"
    "cmake"                 = "语言与平台"
    "hot-reload"            = "语言与平台"
    "concurrency"           = "质量与协作"
    "code-comments"         = "质量与协作"
    "logging-terminal"      = "质量与协作"
    "api-documentation"     = "质量与协作"
    "subagents"             = "质量与协作"
    "research-workflow"     = "研究与机器人"
    "data-experiment"       = "研究与机器人"
    "ml-dev"                = "研究与机器人"
    "robotics"              = "研究与机器人"
    "simulation-hil"        = "研究与机器人"
    "system-safety"         = "研究与机器人"
    "units-coordinate-time" = "研究与机器人"
    "writing"               = "写作与工具"
    "external-tools"        = "写作与工具"
    "windows-environment"   = "写作与工具"
}

$skills = @()
Get-ChildItem $skillsDir -Directory | Sort-Object Name | ForEach-Object {
    $skillFile = Join-Path $_.FullName "SKILL.md"
    if (-not (Test-Path $skillFile)) { return }

    $lines = Get-Content $skillFile -Encoding UTF8
    if ($lines[0] -ne "---") { return }

    # 解析 frontmatter：name 直接取值；description 为 >- 折行标量，逐行拼接
    $name = $_.Name
    $desc = ""
    $inDesc = $false
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -eq "---") { break }
        if ($lines[$i] -match "^name:\s*(.+)$") {
            $name = $Matches[1].Trim()
            $inDesc = $false
        }
        elseif ($lines[$i] -match "^description:\s*>-\s*$") {
            $inDesc = $true
        }
        elseif ($inDesc -and $lines[$i] -match "^\s+(.+)$") {
            $desc += $Matches[1].Trim() + " "
        }
    }
    $desc = $desc.Trim()

    $category = if ($categoryMap.ContainsKey($name)) { $categoryMap[$name] } else { "其他" }
    $skills += [ordered]@{
        name        = $name
        category    = $category
        description = $desc
    }
}

$result = [ordered]@{
    generatedAt = (Get-Date -Format "yyyy-MM-dd")
    source      = "https://github.com/Linmoqian/lin-workflow"
    install     = "pi install git:github.com/Linmoqian/lin-workflow"
    count       = $skills.Count
    skills      = $skills
}

$result | ConvertTo-Json -Depth 4 | Out-File $outFile -Encoding utf8
Write-Host "[成功] 生成 $outFile（$($skills.Count) 个 skill）"
