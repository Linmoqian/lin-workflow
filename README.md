# 说明

本人的工程经验汇总

# 本人背景

生物学、全栈开发、具身智能、计算机视觉

# 仓库用法

以下为提示词：

"使用Git 拉取 https://github.com/Linmoqian/lin-workflow ，然后将其工程规范接入到本项目中，合并而非替换，README和TODO不纳入；其中 .pi/skills/ 下的 Skill 需复制到对应agent的技能加载目录（如Codex 为 .agents/skills/，Claude Code 为 .claude/skills/，dsh为 .dsh/skills/），否则skill不会被作为项目skill被加载"

# 项目看板

overview/README.md 仅为示例，实际项目看板请在项目根目录下的 `.overview/*.json` 中查看。

# 补充

- 仅为本人的工程经验汇总，非官方规范，非团队规范，非通用规范，请结合自身情况灵活使用
- AGENTS和CLAUDE的内容是一致的,方便不同的工具调用
- 因为本人喜欢用pi,所以说是.pi

# 小tips

不要到处装skills、mcp，不要看见哪个star数多就装哪个，这会造成上下文污染，影响原生的agent的工具调用，tokens消耗倍增的同时，agent本身的能力还下降了。注意给项目做减法，少即是多。