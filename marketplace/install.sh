#!/usr/bin/env bash
# 多平台 skill 与子代理安装器（Linux/macOS 版）：把 .pi/skills/ 与 .pi/agents/ 安装到各 agent 平台加载目录
# Created on 2026-10-03
# @author: https://github.com/Linmoqian
#
# 用法（--target 可多选，逗号分隔）：
#   bash marketplace/install.sh                                          # 全部 skill -> ~/.agents/skills/（pi 与 Codex 共享）
#   bash marketplace/install.sh --target claude,codex --agents           # 多平台：skill + 子代理
#   bash marketplace/install.sh --target pi --agents                     # pi 原生：~/.pi/agent/{skills,agents}
#   bash marketplace/install.sh --target dsh                             # ~/.dsh/skills/
#   bash marketplace/install.sh --target project --agents                # 当前项目各平台项目级目录
#   bash marketplace/install.sh --skills python-dev,tauri --target claude
#   bash marketplace/install.sh --list
#
# 平台目录与格式同 install.ps1，详见 marketplace/README.md。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SKILLS_DIR="$REPO_ROOT/.pi/skills"
AGENTS_DIR="$REPO_ROOT/.pi/agents"

SKILLS=()
TARGETS=(agents)
WITH_AGENTS=0
LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skills) IFS=',' read -ra SKILLS <<< "$2"; shift 2 ;;
    --target) IFS=',' read -ra TARGETS <<< "$2"; shift 2 ;;
    --agents) WITH_AGENTS=1; shift ;;
    --list) LIST=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[错误] 未知参数：$1"; exit 1 ;;
  esac
done

VALID_TARGETS=(agents codex claude dsh pi project)
for t in "${TARGETS[@]}"; do
  [[ " ${VALID_TARGETS[*]} " == *" $t "* ]] || { echo "[错误] 未知目标：$t；可选：${VALID_TARGETS[*]}"; exit 1; }
done

# ---------- 解析 pi 子代理 md：字段输出到 stdout，正文写入 $2 指定文件 ----------
parse_agent() {
  local file="$1" body_file="$2"
  awk -v bodyfile="$body_file" '
    NR == 1 { next }
    $0 == "---" { inbody = 1; next }
    !inbody {
      if ($0 ~ /^name:/)        { sub(/^name:[ ]*/, "");        printf "NAME|%s\n", $0 }
      if ($0 ~ /^description:/) { sub(/^description:[ ]*/, ""); printf "DESC|%s\n", $0 }
      if ($0 ~ /^aliases:/)     { sub(/^aliases:[ ]*/, "");     printf "ALIASES|%s\n", $0 }
      if ($0 ~ /^thinking:/)    { sub(/^thinking:[ ]*/, "");    printf "THINKING|%s\n", $0 }
      if ($0 ~ /^output:/)      { sub(/^output:[ ]*/, "");      printf "OUTPUT|%s\n", $0 }
      next
    }
    inbody { print >> bodyfile }
  ' "$file"
}

# ---------- 平台文字适配 ----------
adapt_body() {
  local f="$1"
  sed -i -E \
    -e 's/`CLAUDE\.md`（AGENTS\.md 同源）/AGENTS.md/g' \
    -e 's/CLAUDE\.md（AGENTS\.md 同源）/AGENTS.md/g' \
    -e 's/`CLAUDE\.md`/AGENTS.md/g' \
    -e 's/CLAUDE\.md/AGENTS.md/g' \
    -e 's/`AGENTS\.md`（AGENTS\.md 同源）/AGENTS.md/g' \
    -e 's/（AGENTS\.md 同源）//g' \
    "$f"
}

# ---------- pi md -> Codex role TOML ----------
convert_codex_toml() {
  local file="$1" out="$2"
  local tmp_body; tmp_body="$(mktemp)"
  rm -f "$tmp_body"
  local fields; fields="$(parse_agent "$file" "$tmp_body")"
  local name desc aliases thinking output
  name="$(printf '%s\n' "$fields" | sed -n 's/^NAME|//p' | head -1)"
  desc="$(printf '%s\n' "$fields" | sed -n 's/^DESC|//p' | head -1)"
  aliases="$(printf '%s\n' "$fields" | sed -n 's/^ALIASES|//p' | head -1)"
  thinking="$(printf '%s\n' "$fields" | sed -n 's/^THINKING|//p' | head -1)"
  output="$(printf '%s\n' "$fields" | sed -n 's/^OUTPUT|//p' | head -1)"

  adapt_body "$tmp_body"
  sed -i -E 's/contact_supervisor/send_message/g' "$tmp_body"
  [ -n "$output" ] && printf '\n最终交接产出写入文件 %s。\n' "$output" >> "$tmp_body"

  {
    echo "# 由 lin-workflow marketplace 从 .pi/agents/ 转换生成，勿手改；再生成：bash marketplace/install.sh --agents --target codex"
    echo "name = '$name'"
    printf "description = '%s'\n" "$(printf '%s' "$desc" | sed "s/'/''/g")"
    if [ -n "$aliases" ]; then
      printf 'nickname_candidates = ['
      local first=1 a
      IFS=',' ; for a in $aliases; do
        a="$(echo "$a" | xargs)"; [ -z "$a" ] && continue
        [ $first -eq 1 ] || printf ', '
        printf "'%s'" "$a"; first=0
      done
      unset IFS
      echo ']'
    fi
    if [ -n "$thinking" ]; then
      local effort="$thinking"
      [ "$thinking" = "max" ] && effort="xhigh"
      echo "model_reasoning_effort = '$effort'"
    fi
    printf 'developer_instructions = '"'''"'\n'
    cat "$tmp_body"
    printf "'''"
  } > "$out"
  rm -f "$tmp_body"
}

# ---------- pi md -> Claude Code agents md ----------
declare -A CLAUDE_TOOLS=(
  [read]=Read [grep]=Grep [find]=Glob [ls]=LS [bash]=Bash
  [edit]=Edit [write]=Write [web_search]=WebSearch [fetch_content]=WebFetch
)

convert_claude_md() {
  local file="$1" out="$2"
  local tmp_body; tmp_body="$(mktemp)"
  rm -f "$tmp_body"
  local fields; fields="$(parse_agent "$file" "$tmp_body")"
  local name desc tools_raw output
  name="$(printf '%s\n' "$fields" | sed -n 's/^NAME|//p' | head -1)"
  desc="$(printf '%s\n' "$fields" | sed -n 's/^DESC|//p' | head -1)"
  tools_raw="$(sed -n -E 's/^tools:[ ]*//p' "$file" | head -1)"
  output="$(printf '%s\n' "$fields" | sed -n 's/^OUTPUT|//p' | head -1)"

  adapt_body "$tmp_body"
  sed -i -E \
    -e 's/暂停并通过 `contact_supervisor`（reason 用 need_decision）上报，等待回复后再继续/暂停执行，在最终回复中列出需要主代理决策的事项，由主代理处理后继续/g' \
    -e 's/通过 `contact_supervisor`（reason 用 need_decision）上报并等待回复，不要擅自决定/暂停执行，在最终回复中列出需要主代理决策的事项，不要擅自决定/g' \
    -e 's/通过 `contact_supervisor`（reason 用 need_decision）上报，等待回复后再继续/暂停执行，在最终回复中列出需要主代理决策的事项，由主代理处理后继续/g' \
    -e 's/用 `contact_supervisor`（reason 用 need_decision）向主 agent 询问，而非臆测/在最终回复中列出需主 agent 澄清的问题，而非臆测/g' \
    -e 's/`contact_supervisor`（reason 用 need_decision）/主代理决策上报/g' \
    -e 's/contact_supervisor/主代理决策上报/g' \
    "$tmp_body"
  [ -n "$output" ] && printf '\n最终交接产出写入文件 %s。\n' "$output" >> "$tmp_body"

  local mapped=() t
  IFS=',' ; for t in $tools_raw; do
    t="$(echo "$t" | xargs)"
    [ -n "${CLAUDE_TOOLS[$t]:-}" ] && mapped+=("${CLAUDE_TOOLS[$t]}")
  done
  unset IFS

  {
    echo "---"
    echo "name: $name"
    echo "description: $desc"
    [ ${#mapped[@]} -gt 0 ] && echo "tools: ${mapped[*]}"
    echo "---"
    echo "# 由 lin-workflow marketplace 从 .pi/agents/ 转换生成，勿手改；再生成：bash marketplace/install.sh --agents --target claude"
    echo ""
    cat "$tmp_body"
  } > "$out"
  rm -f "$tmp_body"
}

# ---------- 列清单 ----------
if [ "$LIST" -eq 1 ]; then
  echo "可安装的 skill（源：$SKILLS_DIR）："
  for d in "$SKILLS_DIR"/*/; do
    [ -f "$d/SKILL.md" ] && echo "  - $(basename "$d")"
  done
  if [ -d "$AGENTS_DIR" ]; then
    echo "可安装的子代理（源：$AGENTS_DIR；dsh 无子代理机制不安装）："
    for f in "$AGENTS_DIR"/*.md; do echo "  - $(basename "$f" .md)"; done
  fi
  exit 0
fi

[ -d "$SKILLS_DIR" ] || { echo "[错误] 未找到源目录 $SKILLS_DIR"; exit 1; }

# ---------- 选定 skill ----------
AVAILABLE=()
for d in "$SKILLS_DIR"/*/; do
  [ -f "$d/SKILL.md" ] && AVAILABLE+=("$(basename "$d")")
done

SELECTED=()
if [ ${#SKILLS[@]} -gt 0 ]; then
  for s in "${SKILLS[@]}"; do
    s="$(echo "$s" | xargs)"
    found=0
    for a in "${AVAILABLE[@]}"; do [ "$a" = "$s" ] && { found=1; break; }; done
    [ $found -eq 0 ] && { echo "[错误] 不存在的 skill：$s；用 --list 查看全部"; exit 1; }
    SELECTED+=("$s")
  done
else
  SELECTED=("${AVAILABLE[@]}")
fi

# ---------- 安装 skill ----------
install_skills_to() {
  local dest="$1" label="$2" s
  mkdir -p "$dest"
  for s in "${SELECTED[@]}"; do
    rm -rf "$dest/$s"
    cp -r "$SKILLS_DIR/$s" "$dest/$s"
  done
  echo "[成功] [$label] 已安装 ${#SELECTED[@]} 个 skill 到 $dest"
}

install_agents_to() {
  # $1 目标目录 $2 格式（native|codex|claude） $3 标签
  local dest="$1" form="$2" label="$3" f base
  mkdir -p "$dest"
  for f in "$AGENTS_DIR"/*.md; do
    base="$(basename "$f" .md)"
    case "$form" in
      native) cp "$f" "$dest/$(basename "$f")" ;;
      codex)  convert_codex_toml "$f" "$dest/$base.toml" ;;
      claude) convert_claude_md "$f" "$dest/$base.md" ;;
    esac
  done
  local note=""
  [ "$form" != "native" ] && note="（转换格式）"
  echo "[成功] [$label] 已安装 $(ls "$AGENTS_DIR"/*.md | wc -l | xargs) 个子代理到 $dest$note"
}

for t in "${TARGETS[@]}"; do
  case "$t" in
    agents)  install_skills_to "$HOME/.agents/skills" "$t" ;;
    codex)   install_skills_to "$HOME/.codex/skills" "$t" ;;
    claude)  install_skills_to "$HOME/.claude/skills" "$t" ;;
    dsh)     install_skills_to "$HOME/.dsh/skills" "$t" ;;
    pi)      install_skills_to "$HOME/.pi/agent/skills" "$t" ;;
    project)
      install_skills_to "$PWD/.agents/skills" "$t"
      install_skills_to "$PWD/.claude/skills" "$t"
      install_skills_to "$PWD/.dsh/skills" "$t"
      ;;
  esac
done

# ---------- 安装子代理 ----------
if [ "$WITH_AGENTS" -eq 1 ]; then
  [ -d "$AGENTS_DIR" ] || { echo "[警告] 未找到 $AGENTS_DIR，跳过子代理安装"; exit 0; }
  for t in "${TARGETS[@]}"; do
    case "$t" in
      agents|pi) install_agents_to "$HOME/.pi/agent/agents" native "$t" ;;
      codex)     install_agents_to "$HOME/.codex/agents" codex "$t" ;;
      claude)    install_agents_to "$HOME/.claude/agents" claude "$t" ;;
      project)
        install_agents_to "$PWD/.codex/agents" codex "$t"
        install_agents_to "$PWD/.claude/agents" claude "$t"
        ;;
      dsh) echo "[跳过] [dsh] 无公开子代理契约，不安装" ;;
    esac
  done
fi
