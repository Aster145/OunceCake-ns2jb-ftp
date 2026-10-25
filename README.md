# OunceCake — Windows / ns2jb-ftp 适配

基于 [misshexa66/OunceCake](https://github.com/misshexa66/OunceCake) 的 Windows 适配，用兼容的 `ns2jb-ftp` 引擎保持 RPC 会话，再通过 Switch 2 上的只读 FTP 浏览、下载所选游戏的 RomFS 和 ExeFS。

本项目使用局域网连接，**不通过 USB 传输**。两个命令窗口分别负责 RPC 与 OunceCake，运行时只有一个 FTP 服务。

| 入口 | 用途 |
| --- | --- |
| `NS2JB-RPC.cmd` | 建立并保持 RPC；跳过来源引擎的 FTP 和自动导出流程 |
| `OUNCECAKE-START.cmd` | 完整模式：准备本体、更新及 DLC 中可用的内容，启动主机端 FTP |
| `OUNCECAKE-BASE.cmd` | 仅本体模式：只准备 `/base/romfs` 和 `/base/exefs` |

## 首次准备

需要 Windows、Node.js 22 或更新版本、原引擎支持的 Switch 2 / SmileBASIC 环境，以及电脑与主机可互通的局域网。需自行准备兼容的 Windows `ns2jb-ftp` 源目录和已保存的 SmileBASIC bootstrap；本仓库不附带该来源包。

```powershell
git clone https://github.com/Aster145/OunceCake-ns2jb-ftp.git
cd OunceCake-ns2jb-ftp
node .\prepare-ns2jb.cjs "C:\path\to\ns2jb-ftp"
```

准备工具检查来源代码是否兼容，生成独立的 `ns2jb-host`，不修改来源目录，也不复制旧会话和导出文件。目标目录已存在或版本不匹配时会报错；它不是任意版本 ns2jb 的通用转换器。`ns2jb-host` 是本地生成目录，不随 Git 仓库发布。普通运行不需要 `npm install`、WSL 或重新编译原生程序。

## 启动与下载

1. 重启 Switch 2，打开 SmileBASIC，并准备已保存的 bootstrap。
2. 双击 `NS2JB-RPC.cmd`，按提示选择**电脑的局域网 IP**，在 SmileBASIC 中执行本次显示的命令。初始连接使用 TCP **39380**。
3. 等待 **`RPC ready:`**，保持 RPC 窗口和 SmileBASIC 打开。
4. 双击 `OUNCECAKE-START.cmd`，选择游戏，等待 **`FTP up!`**。
5. FTP 客户端使用普通 FTP、匿名登录，连接 **Switch 2 的局域网 IP，端口 2121**，浏览并下载所需文件。
6. 完成后，在 OunceCake 窗口输入 **`q`** 并回车，等待 **`Stopped`**；再在 RPC 窗口输入 **`q`** 并回车，等待清理完成。

`FTP up!` 表示服务已就绪，不代表游戏已下载到电脑。不要在 OunceCake 工作时先关闭 RPC。完整命令、恢复方式和常见提示见 [Windows 使用说明](WINDOWS-OunceCake.md)。

## 已验证的范围

Windows 离线测试共 **77 项通过**，其中 63 项为基础测试，14 项需外部兼容来源包。Pokémon Pokopia 实机完整模式可列出更新目录中的 **41 个文件**，两个小文件实际下载成功，默认端口 `2121` 与输入 `q` 后的退出清理均已验证。

该次测试的本体没有 RomFS，ExeFS 为空；`/updates/655360/romfs` 有 36 个文件，`/updates/655360/exefs` 有 5 个文件。因此仅本体模式没有可下载内容。**尚未完成整个游戏的下载，也未验证本体文件下载、其他游戏或 DLC。** 更新目录的存在不能作为完整本体已导出的证明。

详细证据范围见 [验证记录](docs/VALIDATION.md)，本分支改动见 [更新记录](CHANGELOG.md)。

## 开发检查

基础测试不需要来源包；未配置来源包时，运行结果为 63 项通过，外部来源集成套件以 1 项跳过标记呈现：

```powershell
node --test test/*.test.cjs
```

要运行全部 77 项测试，在当前 PowerShell 会话指定外部来源目录：

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
