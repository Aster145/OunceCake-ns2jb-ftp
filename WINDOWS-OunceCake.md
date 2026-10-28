# Windows 使用说明

本分支用兼容的 Windows `ns2jb-ftp` 引擎建立 RPC，并由 OunceCake 在 Switch 2 上运行唯一的只读 FTP。电脑与主机通过局域网连接；不需要 USB、WSL 或 `npm install`。

## 首次准备

安装 Node.js 22 或更新版本，准备原引擎支持的 Switch 2 / SmileBASIC 环境及已保存的 bootstrap。在本仓库目录执行：

```powershell
node .\prepare-ns2jb.cjs "C:\path\to\ns2jb-ftp"
```

来源目录需包含兼容版本的 `run.cjs`、`engine` 和 `bootstrap.bas`。工具先检查补丁所需的代码锚点，再生成独立的 `ns2jb-host`，不修改来源目录，不复制旧 runs、连接令牌或导出文件。它会拒绝覆盖已有目标目录；锚点缺失或重复时会报错，但锚点匹配不等于未知来源的全部代码都已验证兼容。

Git clone 后必须执行此步骤；`ns2jb-host` 不包含在公开仓库中。仓库提供 `native.bin` 及其源码，普通运行不需要重新编译。只有修改 `native.c` / `native.h` 时，才需使用 Linux 上的 AArch64 GCC / binutils；当前构建脚本不支持 Windows。

所有启动脚本默认使用项目根目录下的 `ns2jb-host`。已有兼容宿主环境时，可通过以下任一方式指定，环境变量优先：

- 设置环境变量 `OUNCECAKE_NS2JB_HOST`，值为宿主目录的完整路径。
- 在项目根目录新建 `LOCAL-HOST-PATH.txt`，第一行写入宿主目录的完整路径，不加引号。

`LOCAL-HOST-PATH.txt` 是 Git 忽略的本地配置。使用另一目录的宿主时，`Run folder` 指向那个目录属于正常现象；卡带模式是否启动，以 `Card-partition mode` 提示为准。

## 建立新会话并运行

已有正常运行且显示 `RPC ready:` 的会话时，可直接从第 4 步启动 OunceCake；切换模式时按下节说明停止旧实例。

1. 重启 Switch 2，打开 SmileBASIC，进入 Direct 模式，使用已保存的 NS2 bootstrap。
2. 双击 **`NS2JB-RPC.cmd`**，选择主机能访问的**电脑局域网 IP**。按终端提示在 SmileBASIC 执行命令及本次 `V=START(...)`。`REMOVE` 每次应用进程只执行一次；失败后先重启主机再重新开始。
3. 等待 **`RPC ready:`**。保留 RPC 窗口与 SmileBASIC。
4. 选择所需模式：**`OUNCECAKE-START.cmd`** 显示游戏列表，输入编号；**`OUNCECAKE-CARD-PARTITIONS.cmd`** 或 **`启动卡带全分区导出.cmd`** 直接读取当前实体卡；**`OUNCECAKE-INSTALLED-NCA.cmd`** 或 **`启动内部存储NCA导出.cmd`** 显示内部存储的游戏列表，选择后导出原始 NCA。程序自动选择宿主环境中唯一有效的 RPC 会话，等待 **`FTP up!`**。
5. FTP 客户端连接 **Switch 2 的局域网 IP，端口 2121**，使用普通 FTP、匿名登录。这里填写的是主机地址，不是电脑地址或 `127.0.0.1`。
6. 先在 OunceCake 窗口输入 **`q`** 并回车，等待 **`Stopped`**；再在 RPC 窗口输入 **`q`** 并回车，等待清理完成。OunceCake 也支持 `quit` 和 Ctrl+C。结束使用后可重启主机。

两个窗口只有一个 FTP：RPC 初始连接使用 TCP **39380**，游戏下载使用主机端 FTP **2121**。Windows 防火墙询问时，允许 Node.js 使用连接主机的专用网络。启动器不会通过 USB 自动输入 SmileBASIC 命令。

### 保留 RPC 切换模式

先停止 FTP 下载，在当前 OunceCake 窗口输入 `q`，等到 `Stopped` 后关闭该窗口。保留 RPC 窗口和 SmileBASIC，启动另一个 OunceCake 入口，再让 FTP 客户端断开重连并回到根目录。正常会话切换无需重启主机；不要直接关闭运行中的 OunceCake 窗口，也不要同时运行两个实例。

## 完整模式与仅本体模式

`OUNCECAKE-START.cmd` 使用完整模式，准备本体、更新及 DLC 中可用的内容。`OUNCECAKE-BASE.cmd` 只准备 `/base/romfs` 与 `/base/exefs`，排除更新和 DLC；两者都需先建立 RPC。

钥匙卡游戏的本体内容可能没有 RomFS，ExeFS 也可能为空。程序会报告每个挂载的文件数和跳过的分区；总文件数为 0 时停止，不会启动空 FTP。仅本体模式不能代替下载内容的挂载。

当前实测的 Pokémon Pokopia 应使用完整模式：可下载内容位于 `/updates/655360/romfs` 与 `/updates/655360/exefs`，其 `/base/exefs` 为空，本体 RomFS 不存在。这是本次设备内容的观察结果，不代表所有游戏；完整验证范围见 [验证记录](docs/VALIDATION.md)。

## 卡带分区模式

插入实体卡并保持连接，运行 `OUNCECAKE-CARD-PARTITIONS.cmd`；中文入口 `启动卡带全分区导出.cmd` 调用同目录的这个脚本。此模式不显示游戏选择列表，启动时会输出 `Card-partition mode`。

| FTP 路径 | 内容 |
| --- | --- |
| `/card/update` | 卡带系统更新分区中的文件 |
| `/card/normal` | Normal 分区中的文件，可能为空 |
| `/card/secure` | Secure 分区中的游戏内容容器等文件 |
| `/card/logo` | Logo 分区中的文件 |

游戏的 RomFS / ExeFS 位于内容容器内部，与卡带的四类分区处于不同层级。旧模式的 `/updates` 是游戏补丁；它不等于 `/card/update`。这项功能导出逻辑分区中的文件，不生成包含外层头部、卡带证书、填充区的完整 XCI。

等待 `FTP up!` 后，用 FTP 客户端下载所需目录。启动器仅准备文件列表并提供读取服务；已下载过游戏内容时，无需再次下载 Secure。准备结果写入 `reports/card-partitions-*.json`，记录可访问、缺失、空分区或失败状态；报告不会把准备成功标成已下载完成。`not-attempted` 表示尚未尝试读取，不能据此判断分区不存在。

卡带模式使用当前插卡路径打开逻辑文件系统，不在准备期间写入卡带。运行期间不要更换卡带。特定分区的可访问性和内容仍取决于设备环境及实体卡，详情见 [验证记录](docs/VALIDATION.md)。

## 内部存储 NCA 模式

保持 RPC ready，运行 `OUNCECAKE-INSTALLED-NCA.cmd` 或中文入口 `启动内部存储NCA导出.cmd`，按编号选择游戏。菜单按内部存储中的本体、更新、DLC 安装记录去重；只有更新或 DLC 的游戏也会显示。名称无法读取时按 Title ID 识别，输入 `q` 可退出选单。

固定导出 Pokopia 可使用 `OUNCECAKE-POKOPIA-NCA.cmd` 或 `启动Pokopia内部存储NCA导出.cmd`。切换前先在旧 OunceCake 窗口输入 `q` 并等到 `Stopped`；保留 RPC 和 SmileBASIC。

等待 `FTP up!` 后断开重连 FTP，下载 `/installed/<title-id>/`。本体、更新和 DLC 分别位于 `base/<version>`、`updates/<content-title>/<version>`、`dlc/<content-title>/<version>`。文件保留存储中的 `<ContentId>.nca` 名称，包括 Meta NCA。准备清单位于 `reports/installed-nca-*.json`，下载后按文件大小及 FTP 传输结果核对。

此模式只读访问内部 User 存储中属于所选游戏的原始 NCA，不包含卡带、SD、票据、密钥或存档，也不转换为 NSP/XCI。RomFS / ExeFS 文件视图继续使用 `OUNCECAKE-START.cmd`。游戏内容若在 SD 上，此入口不会导出那部分。

## 可选命令

仅检查本地运行文件与 RPC 桥接状态，不挂载游戏或启动 FTP：

```powershell
node .\ouncecake.cjs --ns2jb .\ns2jb-host --check
```

仅本体模式：

```powershell
node .\ouncecake.cjs --ns2jb .\ns2jb-host --base-only
```

卡带分区模式，不与游戏 Title ID 或 `--base-only` 同时使用：

```powershell
node .\ouncecake.cjs --ns2jb .\ns2jb-host --card-partitions
```

内部存储 NCA：省略 Title ID 显示选单，提供 ID 则直接选择；不能与 `--base-only` 或 `--card-partitions` 同时使用：

```powershell
node .\ouncecake.cjs --ns2jb .\ns2jb-host --installed-nca
node .\ouncecake.cjs --ns2jb .\ns2jb-host --installed-nca 0400A3A01EE4C000
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
| 仍显示 `/base`、`/updates`、`/dlc` | 当前为游戏内容模式。正常停止后运行卡带入口，确认出现 `Card-partition mode`，再让 FTP 客户端断开重连。 |
| 卡带分区状态为 `not-attempted` | 读取尚未进行；检查后续错误和报告，不能把它视作分区为空。 |
| `No installed NCA packages` / `No installed game content` | 内部存储中没有对应的完整安装记录；确认内容是否仅在卡带或 SD 上。 |
| `Unknown title` | 名称读取失败，仍可按显示的 Title ID 选择游戏。 |
| 本体无 RomFS、ExeFS 为空 | 所选本体没有可下载文件；使用完整模式查看可用更新内容。 |
| `Unsupported ns2jb ...` | 来源代码与准备工具要求的版本不匹配；需提供兼容的 Windows `ns2jb-ftp` 包。 |
| `Memory request timed out` / `Console response timed out` | 当前会话不能视为健康；先停止 OunceCake，再按 RPC 的提示重启主机并建立新会话，不重复使用旧会话。 |
| `resources are retained` | 未能确认线程已停止；按提示重启主机，不继续正常的资源清理流程。 |
| 电脑窗口已退出，但旧 FTP 仍可连接 | 设备端服务仍在运行。重启 Switch 2 清除后重新建立 RPC；再次启动 OunceCake 可能因端口占用失败。 |

不要把准备阶段、FTP 空目录或仅完成文件列表读取当成文件导出成功。
