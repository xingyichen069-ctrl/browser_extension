# 浏览器里的两个小工具

我在日常用 Edge 的时候做的两个扩展：一个留住数独成绩，一个少翻几次上传文件夹。

| 工具 | 什么时候用 | 说明 |
| --- | --- | --- |
| 数独手记 | 在 Sudoku.com 玩完一局后，想留下日期、难度和用时，偶尔回头看看 | [安装与使用](sudoku/README.md) |
| 上传文件夹规则 | 给课程网站交 PDF、给另一个网站传图片，每次都要重新找目录 | [安装与使用](upload-folder-rules/README.md) |

两者各自安装，不需要一起启用。目前以 Windows 上的 Microsoft Edge 为目标，没有上架扩展商店。网页介绍可以用手机阅读，安装和使用扩展需要电脑 Edge。

## 安装

在本仓库点击 **Code → Download ZIP**，解压到一个准备长期保留的位置。在 Edge 地址栏打开 `edge://extensions`，开启「开发人员模式」，点击「加载解压缩的扩展」：

- 数独手记：选 `sudoku/extension`。
- 上传文件夹规则：选 `upload-folder-rules/extension`。

选中的那一层应当直接看得到 `manifest.json`。不需要安装 Node.js 或 Python。不要加载整个仓库，也不要选 ZIP 文件本身。

## 数据放在哪里

数独记录保存在当前浏览器的扩展数据库中，可以导出 JSON 备份。上传规则与文件夹授权也留在当前浏览器；扩展只把你选择的文件交给发起上传的网站。两者都没有自己的云端服务，数据不随 Edge 账号自动同步。

更新文件前先备份设置或记录，保留原安装目录，然后在扩展管理页点击「重新加载」。源码说明里的示例不包含使用者的真实记录、文件夹授权或浏览器登录状态。

## 目录

每个工具的 `extension/` 是安装内容，`tests/`、`tools/` 与 `docs/` 用于开发和查问题。开发方法分别见 [数独维护说明](sudoku/docs/MAINTENANCE.md) 和 [上传规则维护说明](upload-folder-rules/docs/MAINTENANCE.md)。

个人网站：[MotoroOkina](https://motorookina.site)。
