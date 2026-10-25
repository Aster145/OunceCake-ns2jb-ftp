# Windows 使用说明

本分支用兼容的 Windows `ns2jb-ftp` 引擎建立 RPC，并由 OunceCake 在 Switch 2 上运行唯一的只读 FTP。电脑与主机通过局域网连接；不需要 USB、WSL 或 `npm install`。

## 首次准备

安装 Node.js 22 或更新版本，准备原引擎支持的 Switch 2 / SmileBASIC 环境及已保存的 bootstrap。在本仓库目录执行：

```powershell
node .\prepare-ns2jb.cjs "C:\path\to\ns2jb-ftp"
```

来源目录需包含兼容版本的 `run.cjs`、`engine` 和 `bootstrap.bas`。工具先检查补丁所需的代码锚点，再生成独立的 `ns2jb-host`，不修改来源目录，不复制旧 runs、连接令牌或导出文件。它会拒绝覆盖已有目标目录；锚点缺失或重复时会报错，但锚点匹配不等于未知来源的全部代码都已验证兼容。

Git clone 后必须执行此步骤；`ns2jb-host` 不包含在公开仓库中。仓库提供 `native.bin` 及其源码，普通运行不需要重新编译。只有修改 `native.c` / `native.h` 时，才需使用 Linux 上的 AArch64 GCC / binutils；当前构建脚本不支持 Windows。

## 每次运行

1. 重启 Switch 2，打开 SmileBASIC，进入 Direct 模式，使用已保存的 NS2 bootstrap。
2. 双击 **`NS2JB-RPC.cmd`**，选择主机能访问的**电脑局域网 IP**。按终端提示在 SmileBASIC 执行命令及本次 `V=START(...)`。`REMOVE` 每次应用进程只执行一次；失败后先重启主机再重新开始。
3. 等待 **`RPC ready:`**。保留 RPC 窗口与 SmileBASIC。
4. 双击 **`OUNCECAKE-START.cmd`**。程序自动选择该独立环境中唯一有效的 RPC 会话，显示游戏列表；输入编号后等待 **`FTP up!`**。
5. FTP 客户端连接 **Switch 2 的局域网 IP，端口 2121**，使用普通 FTP、匿名登录。这里填写的是主机地址，不是电脑地址或 `127.0.0.1`。
6. 先在 OunceCake 窗口输入 **`q`** 并回车，等待 **`Stopped`**；再在 RPC 窗口输入 **`q`** 并回车，等待清理完成。OunceCake 也支持 `quit` 和 Ctrl+C。结束使用后可重启主机。

两个窗口只有一个 FTP：RPC 初始连接使用 TCP **39380**，游戏下载使用主机端 FTP **2121**。Windows 防火墙询问时，允许 Node.js 使用连接主机的专用网络。启动器不会通过 USB 自动输入 SmileBASIC 命令。

## 完整模式与仅本体模式

`OUNCECAKE-START.cmd` 使用完整模式，准备本体、更新及 DLC 中可用的内容。`OUNCECAKE-BASE.cmd` 只准备 `/base/romfs` 与 `/base/exefs`，排除更新和 DLC；两者都需先建立 RPC。

钥匙卡游戏的本体内容可能没有 RomFS，ExeFS 也可能为空。程序会报告每个挂载的文件数和跳过的分区；总文件数为 0 时停止，不会启动空 FTP。仅本体模式不能代替下载内容的挂载。

当前实测的 Pokémon Pokopia 应使用完整模式：可下载内容位于 `/updates/655360/romfs` 与 `/updates/655360/exefs`，其 `/base/exefs` 为空，本体 RomFS 不存在。这是本次设备内容的观察结果，不代表所有游戏；完整验证范围见 [验证记录](docs/VALIDATION.md)。

## 可选命令

仅检查本地运行文件与 RPC 桥接状态，不挂载游戏或启动 FTP：

```powershell
node .\ouncecake.cjs --ns2jb .\ns2jb-host --check
```

仅本体模式：

```powershell
node .\ouncecake.cjs --ns2jb .\ns2jb-host --base-only
```

直接指定终端显示的 `Run folder`，也兼容原上游保持的 RPC 会话：

```powershell
node .\ouncecake.cjs "C:\path\to\ns2jb-host\runs\<run-folder>"
```

指定游戏 Title ID 和 FTP 端口，省略交互选单：

```powershell
node .\ouncecake.cjs --ns2jb .\ns2jb-host 0100000000000001 --port 2221
```

Title ID 仅为格式示例，需换成实际游戏的 ID。多个有效 RPC 会话存在时，程序要求明确指定目录；过期、已结束或尚未就绪的会话不会被自动使用。

## 常见提示

| 提示或现象 | 含义与处理 |
| --- | --- |
| `No RPC runs found` | 先运行 `NS2JB-RPC.cmd`，等到 `RPC ready:`；确认使用本仓库生成的运行环境。 |
| `Opening /updates/...` | 正在准备内容，尚未启动 FTP；等待完成或明确报错。 |
| `FTP up!` | FTP 已就绪，仍需用客户端下载文件，不代表导出完成。 |
| 本体无 RomFS、ExeFS 为空 | 所选本体没有可下载文件；使用完整模式查看可用更新内容。 |
| `Unsupported ns2jb ...` | 来源代码与准备工具要求的版本不匹配；需提供兼容的 Windows `ns2jb-ftp` 包。 |
| `Memory request timed out` / `Console response timed out` | 当前会话不能视为健康；先停止 OunceCake，再按 RPC 的提示重启主机并建立新会话，不重复使用旧会话。 |
| `resources are retained` | 未能确认线程已停止；按提示重启主机，不继续正常的资源清理流程。 |
| 电脑窗口已退出，但旧 FTP 仍可连接 | 设备端服务仍在运行。重启 Switch 2 清除后重新建立 RPC；再次启动 OunceCake 可能因端口占用失败。 |

不要把完整模式卡在准备阶段、FTP 空目录或仅完成文件列表读取当成游戏导出成功。
