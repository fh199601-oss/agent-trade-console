# 钱包账号池快速接入（给安装 AI）

目标：复用用户已经能用的钱包启动入口，直接交给安装器。不搬钱包，不重新登录，不要求用户整理账号池。只调用 `wallet status --json`、`wallet address --json` 核验。

**先读 [钱包环境保护](WALLET_SAFETY.md)。只读业务命令也可能让上游 CLI 更新登录状态；必须先确认原环境，不能用新安装的主机 CLI 检查容器登录目录。**

## 按这个顺序做，避免反复搜索

1. 当前对话、项目说明或用户已经给了钱包路径：**直接用路径，跳过自动搜索**。
2. 已有本安装的绑定：`setup.py start`；不重新发现、不逐钱包重复安装。确实要重查时，停止本安装后 `setup.py --recheck-wallets`。
3. 任意目录中有 `accountN.sh/.ps1/.cmd/.bat/.py/.js/.mjs/.exe`：`setup.py --wallet-dir "完整目录"`。也接受包含 `wallet-containers` 的工作区。`accounts.json` 可选，有公开绑定时须与实时地址一致；未绑定的空槽不探测。
4. 启动文件叫其他名字：`setup.py --wallet-entry "1=完整入口路径" --wallet-entry "2=另一个入口路径"`。
5. 多账号共用一个管理程序、需要选择账号参数、或需要 WSL/指定解释器：创建下述**公开接入清单**，然后 `setup.py --wallet-map "清单完整路径"`。
6. 完全不知道入口位置时，最多运行一次 `setup.py discover`。它只扫描常见公开目录的文件名，限深度、数量和约 3 秒时间预算。没有结果时查看该钱包工具的安装说明和公开启动文件，生成清单；不要全盘反复搜索，不打开私钥、`.baw`、数据卷或浏览器存储。

这些命令用便携包中的 Python 执行：Windows `portable/python/python.exe`，Mac `./portable/python/bin/python3`。可先用 `setup.py discover --wallet-map "路径"` 校验清单，它不执行任何钱包命令。

## 不同启动方式统一为一份清单

在用户自己的本地数据目录生成 `wallet-entrypoints.json`。不要放入开源仓库或对外分享。

```json
{
  "schema": 1,
  "wallets": [
    {
      "account": 1,
      "command": ["/path/to/existing-pool.py", "--account", "alice"],
      "cwd": "/path/to/pool"
    },
    {
      "account": 2,
      "command": ["/path/to/existing-pool.py", "--account", "bob"],
      "cwd": "/path/to/pool"
    }
  ]
}
```

- 示例路径/参数必须替换为本机真实的**现有入口**，不要照搬创建新钱包。Windows 路径使用 `C:/WalletPool/...` 或合法 JSON 双反斜线。
- `account`：本看板编号 1–200，不要求原账号池也叫 account1。保留用户原编号，不因核验失败重新排列。
- `command`：参数数组，不使用拼接 Shell 字符串。Python/JS 入口使用原 shebang 或原 PATH 的解释器，不使用看板便携解释器。已有虚拟环境时，把原解释器绝对路径放在第一项，脚本路径放在第二项；保留虚拟环境路径，不替换为其符号链接目标。原有工作目录用 `cwd` 保留。
- 默认把钱包命令追加到数组末尾，例如 `existing-pool.py --account alice wallet status --json`。入口要求命令在中间时，在正确位置放一次 `"{args}"`，程序按数组展开，不做字符串插值。
- `address` 可选，只能填已有的 BSC 公开绑定；缺省由原入口只读返回。重复地址、地址不一致和不明确的链都会阻止绑定。
- `lockGroup` 可选。同一个底层会话通过不同命令别名调用时，给它们相同的公开分组名以串行访问。原入口的账号锁始终保留；不能绕过原入口直接启动容器或读取会话。
- 清单不接受环境变量、私钥、令牌或登录字段。环境设置留在原钱包入口内；不向聊天输出入口的原始响应或错误日志。

兼容的是 **Binance Agentic Wallet 的命令与 JSON 协议**，不等于能读任意钱包数据库。若朋友使用其他账号池接口，安装 AI 应依据该工具文档做一个薄适配入口：将命令转给原管理程序，保留其账号选择与锁，并仅规范 JSON 输出。不要为凑接口伪造 CONNECTED、地址或交易结果；不支持的操作明确返回错误。安装阶段只测试状态和地址，不能拿真实交易验证适配器。

## 时间限制和故障处理

- 默认 4 个独立钱包并行核验，总验证预算 30 秒，每个 CLI 调用最多 12 秒；同一会话仍串行。进程退出清理可能另需几秒，不代表整个下载安装在 30 秒内完成。
- 正常钱包先接入，慢/断线钱包写入 `issues`；看板仍返回网址。保留已有绑定，暂时断线不会删除账户映射。
- JSON 中的 `walletCheck` 包含核验耗时、并发和是否复用绑定。不要把模拟入口成绩当成真实网络连接速度。
- 超时只定位对应入口；不要整套重新安装。`WALLET_DISCONNECTED` / `WALLET_STATUS_FAILED` 要先检查原环境，不能直接重新登录。`WALLET_ENVIRONMENT_NOT_READY` 表示原环境未就绪，不能靠重复安装 Docker 解决。`WALLET_LAUNCHER_UNSAFE` 表示调用前环境检查未通过，查看公开入口，勿修改登录文件或移除检查。
- 多套互不相关的账号池不能擅自合并；有明确用户范围时由安装 AI 用一份清单列出选定入口，否则请用户选目录。
- 最后验证 `url` 页面和 bootstrap 的 `installationId`，返回完整网址及已接入数量、未接入原因。安装不启动交易或自动任务。
