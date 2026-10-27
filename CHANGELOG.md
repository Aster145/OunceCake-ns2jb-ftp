# 更新记录

## Unreleased — 2026-10-27

- 新增 `--card-partitions`，通过只读 FTP 暴露当前实体卡的 Update、Normal、Secure、Logo 逻辑分区文件；保留原游戏完整模式和仅本体模式。
- 新增 `OUNCECAKE-CARD-PARTITIONS.cmd` 与同目录中文入口 `启动卡带全分区导出.cmd`。
- 启动脚本支持 `OUNCECAKE_NS2JB_HOST` 环境变量和本地 `LOCAL-HOST-PATH.txt`，便于复用已有宿主；默认仍使用同目录 `ns2jb-host`。
- 修复卡带查询在实测 Switch 2 环境中关闭会话的问题，使用 NCM GameCard 存储的当前内容路径访问分区，避免旧 DeviceOperator 200 / 202 调用。
- 增加卡带模式参数校验、分区状态与计数报告及相关离线测试；报告明确区分准备完成与传输完成。
- Super Mario Party Jamboree 实体卡验证：Update 299 个文件与 Logo 4 个文件全部下载，共 769,838,968 字节，逐文件大小与 FTP 完成响应通过；Normal 为空，Secure 仅枚举。正常退出后 RPC 保持 ready。
- 补充模式切换说明：等待当前 OunceCake 显示 `Stopped` 后，可保留 RPC 和 SmileBASIC 启动另一模式，无需重启正常会话。

卡带模式不生成完整 XCI；本次未判定导出更新文件的固件版本。完整证据范围见 [验证记录](docs/VALIDATION.md)。

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

1.0.0 发布时尚未验证完整游戏下载、本体文件下载、其他游戏及 DLC。后续验证见 [验证记录](docs/VALIDATION.md)。
