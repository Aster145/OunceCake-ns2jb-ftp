# 更新记录

## 1.0.0 — 2026-10-26

首个 Windows / `ns2jb-ftp` 适配版本，基于 [misshexa66/OunceCake](https://github.com/misshexa66/OunceCake)。

- 新增 `prepare-ns2jb.cjs`，从兼容来源生成独立 RPC 环境，保留原目录。
- 新增 Windows RPC、完整模式和仅本体模式启动入口；运行时仅使用 OunceCake 的主机端 FTP。
- 支持自动选择唯一有效的 RPC 会话、`--check` 检查及 Windows 命名管道。
- 修复更新 RomFS 挂载对固定 FS 全局地址的依赖。
- 显示缺失分区和文件数，阻止空内容启动 FTP。
- 支持输入 `q` 或 `quit` 正常退出，等待资源清理完成后显示 `Stopped`。
- 补充 63 项基础测试、14 项外部来源集成测试，以及 Pokopia 的目录、两个小文件下载和正常退出实机验证。
- 提供 Windows / Node.js 22、24 的基础测试 CI；宿主来源包与本地运行数据不随仓库发布。

完整游戏下载、本体文件下载、其他游戏及 DLC 尚未验证。详情见 [验证记录](docs/VALIDATION.md)。
