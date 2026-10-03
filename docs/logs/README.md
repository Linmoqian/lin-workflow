# 开发日志

按日期（log）或月份（CSV）记录开发过程流水。格式、类型枚举与写入时机遵循 `dev-log` Skill（`.pi/skills/dev-log/SKILL.md`）。

速查：

- log：`YYYY-MM-DD.log`，行格式 `[HH:MM] TYPE | module | summary`
- CSV：`YYYY-MM.csv`，表头 `date,time,type,module,summary,ref`
- 类型：FEAT / FIX / DECISION / ISSUE / RISK / NOTE（CSV 用小写）

本目录不存放密钥与敏感信息；日志只追加，不回改历史。
