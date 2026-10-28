# OunceCake — Windows / ns2jb-ftp 适配

基于 [misshexa66/OunceCake](https://github.com/misshexa66/OunceCake) 的 Windows 适配，用兼容的 `ns2jb-ftp` 引擎保持 RPC 会话，再通过 Switch 2 上的只读 FTP 浏览、下载游戏 RomFS / ExeFS、实体卡的逻辑分区文件或内部存储的原始 NCA。

本项目使用局域网连接，**不通过 USB 传输**。两个命令窗口分别负责 RPC 与 OunceCake，运行时只有一个 FTP 服务。

| 入口 | 用途 |
| --- | --- |
| `NS2JB-RPC.cmd` | 建立并保持 RPC；跳过来源引擎的 FTP 和自动导出流程 |
| `OUNCECAKE-START.cmd` | 游戏完整模式：准备本体、更新及 DLC 中可用的 RomFS / ExeFS，启动主机端 FTP |
| `OUNCECAKE-BASE.cmd` | 仅本体模式：只准备 `/base/romfs` 和 `/base/exefs` |
| `OUNCECAKE-INSTALLED-NCA.cmd` / `启动内部存储NCA导出.cmd` | 内部存储 NCA 导出：显示游戏列表，按编号选择游戏 |
| `OUNCECAKE-POKOPIA-NCA.cmd` / `启动Pokopia内部存储NCA导出.cmd` | 直接选择 Pokopia，导出内部存储中已安装的原始 NCA |
| `OUNCECAKE-CARD-PARTITIONS.cmd` | 卡带分区模式：准备当前实体卡的 Update、Normal、Secure、Logo 文件 |
| `启动卡带全分区导出.cmd` | 卡带分区模式的中文入口，与上一项相同 |

## 首次准备

需要 Windows、Node.js 22 或更新版本、原引擎支持的 Switch 2 / SmileBASIC 环境，以及电脑与主机可互通的局域网。需自行准备兼容的 Windows `ns2jb-ftp` 源目录和已保存的 SmileBASIC bootstrap；本仓库不附带该来源包。

```powershell
git clone https://github.com/Aster145/OunceCake-ns2jb-ftp.git
cd OunceCake-ns2jb-ftp
node .\prepare-ns2jb.cjs "C:\path\to\ns2jb-ftp"
```

准备工具检查来源代码是否兼容，生成独立的 `ns2jb-host`，不修改来源目录，也不复制旧会话和导出文件。目标目录已存在或版本不匹配时会报错；它不是任意版本 ns2jb 的通用转换器。`ns2jb-host` 是本地生成目录，不随 Git 仓库发布。普通运行不需要 `npm install`、WSL 或重新编译原生程序。

启动脚本默认使用同目录的 `ns2jb-host`。复用已有环境时，可设置 `OUNCECAKE_NS2JB_HOST` 环境变量，或在项目根目录创建 `LOCAL-HOST-PATH.txt`，第一行填写宿主目录的完整路径；环境变量优先。这个本地配置文件不提交到 Git。

## 启动与下载

以下从建立新会话开始。已有正常运行且显示 `RPC ready:` 的会话时，可直接从第 4 步启动 OunceCake。

1. 重启 Switch 2，打开 SmileBASIC，并准备已保存的 bootstrap。
2. 双击 `NS2JB-RPC.cmd`，按提示选择**电脑的局域网 IP**，在 SmileBASIC 中执行本次显示的命令。初始连接使用 TCP **39380**。
3. 等待 **`RPC ready:`**，保持 RPC 窗口和 SmileBASIC 打开。
4. 游戏内容使用 `OUNCECAKE-START.cmd` 并选择游戏；卡带分区使用 `OUNCECAKE-CARD-PARTITIONS.cmd`，无需选择游戏；内部存储原始 NCA 使用 `OUNCECAKE-INSTALLED-NCA.cmd` 并选择游戏。等待 **`FTP up!`**。
5. FTP 客户端使用普通 FTP、匿名登录，连接 **Switch 2 的局域网 IP，端口 2121**，浏览并下载所需文件。
6. 完成后，在 OunceCake 窗口输入 **`q`** 并回车，等待 **`Stopped`**；再在 RPC 窗口输入 **`q`** 并回车，等待清理完成。

`FTP up!` 表示服务已就绪，不代表游戏已下载到电脑。不要在 OunceCake 工作时先关闭 RPC。完整命令、恢复方式和常见提示见 [Windows 使用说明](WINDOWS-OunceCake.md)。

要切换模式，先停止 FTP 传输，在当前 OunceCake 窗口输入 `q`，等到 `Stopped`。保留 RPC 窗口和 SmileBASIC，启动另一个入口，再让 FTP 客户端断开重连。正常会话切换无需重启主机，不要同时运行两个 OunceCake。

## 卡带分区与游戏内容

卡带模式在 `/card/update`、`/card/normal`、`/card/secure`、`/card/logo` 暴露可读取的分区文件。游戏本体的 NCA 通常位于 Secure，其中才包含 RomFS / ExeFS；游戏内容模式会将这些内容展开。`/updates` 是游戏补丁目录，`/card/update` 是卡带系统更新分区，两者不同。

这里的“全分区”指四类逻辑文件系统中的文件，不包含完整 XCI 的外层头部、卡带证书或填充区。启动器不会自动下载；只需在 FTP 客户端选择所需目录，例如已经取得游戏内容时，可以只下载 `/card/update` 和 `/card/logo`。准备阶段会在 `reports` 生成分区状态与计数报告，准备成功不代表传输完成。

## 内部存储 NCA 导出

导出其他游戏使用 `OUNCECAKE-INSTALLED-NCA.cmd`：启动后按编号选择游戏。列表按内部存储中本体、更新及 DLC 安装记录的所属应用去重，只有更新内容的游戏也会显示；仅在卡带或 SD 上有内容的游戏不在此列表中。也可在启动脚本后加 Title ID 跳过选单，或使用 `node .\ouncecake.cjs --ns2jb .\ns2jb-host --installed-nca [title-id]`。

`OUNCECAKE-POKOPIA-NCA.cmd` 固定选择 Pokopia（`0400A3A01EE4C000`），从内部 User 内容存储按安装元数据筛选本体、更新和 DLC 的全部 NCA 内容类型。FTP 显示在 `/installed` 下，保留存储中的 `<ContentId>.nca` 文件名；`reports/installed-nca-*.json` 记录每个文件的路径、大小和安装版本。钥匙卡上的小 NCA 不会混入此目录。

先在旧 OunceCake 窗口输入 `q`，等 `Stopped`，保留 RPC 和 SmileBASIC，再双击新入口。等 `FTP up!` 后，用 FTP 客户端连接 Switch 2 IP、端口 `2121`，断开重连以刷新目录，下载整个 `/installed`。退出顺序仍是先 OunceCake、再 RPC。此入口只读，不支持覆盖或删除主机文件。

这是已安装的原始 NCA 导出，不生成 NSP/XCI，也不导出票据、密钥或存档。只检查内部存储；移到 SD 的内容不会被包含。准备清单成功不代表下载完成，请核对文件大小和客户端的传输完成状态。

```powershell
node .\ouncecake.cjs --ns2jb .\ns2jb-host 0400A3A01EE4C000 --installed-nca
```

## 已验证的范围

Pokémon Pokopia 实机游戏完整模式可列出更新目录中的 **41 个文件**，两个小文件实际下载成功，默认端口 `2121` 与输入 `q` 后的退出清理均已验证。

该次测试的本体没有 RomFS，ExeFS 为空；`/updates/655360/romfs` 有 36 个文件，`/updates/655360/exefs` 有 5 个文件。因此仅本体模式没有可下载内容；未完成整个游戏或 DLC 的下载验证。

2026-10-27 在 Super Mario Party Jamboree 实体卡上验证卡带模式：Update 的 **299 个文件**和 Logo 的 **4 个文件**全部下载，共 **769,838,968 字节**，逐文件大小与 FTP `226` 完成响应核对通过；Normal 为空，Secure 仅枚举、未下载。`q` 正常退出后 RPC 仍 ready。尚未判定这批系统更新文件对应的固件版本。

2026-10-28 内部存储 NCA 模式实测：Pokopia 更新包的 **4 个完整 NCA，共 7,300,278,272 字节**全部下载；通用入口选择 SmileBASIC 4 后，其本体与更新的 **10 个完整 NCA，共 180,740,608 字节**全部下载。逐文件大小与 FTP `226` 完成响应核对通过，输入 `q` 后正常关闭 FTP 并保留 RPC。

详细证据范围见 [验证记录](docs/VALIDATION.md)，本分支改动见 [更新记录](CHANGELOG.md)。

## 开发检查

基础测试不需要来源包；未配置来源包时，外部来源集成套件以 1 项跳过标记呈现：

```powershell
node --test test/*.test.cjs
```

要同时运行外部来源集成测试，在当前 PowerShell 会话指定兼容来源目录：

```powershell
$env:OUNCECAKE_NS2JB_SOURCE = 'C:\path\to\ns2jb-ftp'
node --test test/*.test.cjs
```

GitHub Actions 使用 Windows、Node.js 22 / 24 运行基础测试。测试不连接主机；硬件兼容性与实际文件下载仍需在目标设备验证。公开仓库不附带 ns2jb 宿主源码、测试用来源副本或生成的运行环境。

仓库提供 `native.bin` 及其源码，普通运行直接使用该文件。只有修改原生代码 `native.c` / `native.h` 时才需重新构建；当前 `engine/build-ftp.cjs` 仅支持 Linux，需要 AArch64 GCC / binutils。

## 来源与许可

- 原始项目：[misshexa66/OunceCake](https://github.com/misshexa66/OunceCake)。本仓库保留其游戏内容访问与 FTP 实现，并增加 Windows `ns2jb-ftp` 适配及相关修复。
- RPC 基础来自 ns2jb；原项目使用 [kurumuz 的 ns2jb 分支](https://gitlab.com/kurumuz/ns2jb)。本适配的准备工具针对兼容的 Windows `ns2jb-ftp` 来源包，其引擎需另行提供并遵守原许可。
- OunceCake 使用了少量 [Atmosphère](https://github.com/Atmosphere-NX/Atmosphere) 代码，按 **GNU GPL v2** 发布；许可证见 [LICENSE](LICENSE)。

仅用于访问自己主机上、自己拥有的游戏内容；请勿分享导出的游戏文件。本项目不提供系统密钥或游戏文件，文件由主机系统加载后通过 FTP 读取。
