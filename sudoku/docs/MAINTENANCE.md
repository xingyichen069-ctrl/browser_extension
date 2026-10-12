# 维护数独手记

`content/page-bridge.js` 读取页面提供的当前局信息，`content/capture.js` 观察操作与胜利状态，后台服务把完成事件写进 IndexedDB。`shared/model.js` 管记录校验、去重和统计；`ui/` 管弹窗与统计页。不要用整页“祝贺”文字判断完成，也不要把题号当成一次尝试的唯一身份。

开发用 Node.js 20+；在 `sudoku/` 运行 `npm ci`，再执行：

```sh
npm test
npm run test:database
npm run test:browser
python tools/package.py
```

浏览器检查需要已安装的 Microsoft Edge，使用独立配置和合成成绩，不读取个人浏览器。打包还需要 Python 3.12+，只把 `extension/` 放进 ZIP。日常安装不需要这些开发依赖。

网站改版时先确认类型、模式和胜利界面的元数据，再改捕获逻辑。改数据库或备份格式前看 [BACKUP_FORMAT.md](BACKUP_FORMAT.md)，检查重复导入、事务失败、损坏输入及已有成绩保留。测试生成的 `qa/`、浏览器配置和 `release/` 不提交。

源码中的自动化检查不等于所有网站活动或每位使用者的实际浏览器都已验收。首次安装后，先用一局真实游戏确认工具栏识别与保存结果，再依赖自动统计。

公开整理检查（2026-10-12）：模型 26 项、数据库 18 项、浏览器 18 项通过。使用当前公开副本执行；这些结果仍受上述隔离环境与原生选择窗口的验证范围限制。
