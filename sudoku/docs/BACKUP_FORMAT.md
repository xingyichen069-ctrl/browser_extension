# 备份格式 v1

普通 JSON 备份顶层包含 `app: "sudoku-journal"`、`schemaVersion: 1`、`exportedAt` 和 `records`。单文件最大 64 MiB，最多五万条。导入逐项校验，然后在一个事务内合并。导出使用紧凑 JSON；合法记录的字段长度与编码上限确保五万条完整备份低于文件上限，中文备注不会因此被截断。

每条记录的白名单字段：

| 字段 | 含义 |
| --- | --- |
| id | 稳定记录 ID；自动记录以 auto: 开头。相同 ID/相同内容跳过；同 ID/不同内容整批冲突拒绝 |
| site | 固定 sudoku.com |
| variant | classic / killer / unknown |
| difficulty | easy / medium / hard / expert / master / extreme / unknown |
| mode | regular / daily / postcards / storybook / croco / unknown |
| completedAt | 自动记录的 UTC ISO 时间；手动只知道日期时为 null |
| localDate | 完成时当地日期 YYYY-MM-DD；之后不按当前时区重算 |
| timeZone | 记录时的 ASCII 时区标识，如 Asia/Shanghai、UTC；不存本地化名称 |
| durationSeconds | 非负整数秒；未知为 null，不当成零参与平均 |
| source | automatic / manual |
| puzzleKey | 当前题目的最小 ASCII 编码标识；手动可为 null；不用于永久合并重玩 |
| note | 用户备注，最多 200 字符 |

普通备份只包含有效记录，不含回收站、暂停设置、临时队列或删除去重标记。CSV 是查看格式；JSON 才保留无损恢复所需身份信息。

`app: "sudoku-journal-recovery"` 是单独的故障诊断格式，可能包含尚未保存或已经损坏的条目和原始会话内容，不能直接导入普通统计库。请先核对和修复，再显式恢复；不要批量把它们当成新完成重复计数。
