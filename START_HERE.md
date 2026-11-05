# 安装与故障处理

## 便携版

下载对应系统/芯片的 Release ZIP，完整解压到固定目录。Windows 双击 `Start.vbs`；Mac 双击 `Start.command`。不要在压缩文件预览里运行，不需要管理员权限。系统对未签名下载程序的提示需由用户本人核对处理，AI 不得关闭安全检查或绕过系统拦截。

运行环境随包提供，不安装到系统、不修改全局 PATH。包内 Node/Python 与所有依赖均列入 MANIFEST；运行时来源和原始 SHA256 在 PORTABLE.json。发行 ZIP 的 SHA256 也在 Release 提供；校验和不是第三方审计或作者数字签名。

仅提供真实交易模式。安装、识别、查询与预览不会提交交易；只有本人明确点击交易或给 bot 本次具体执行指令后才签名。开盘任务必须单独点击启动，重启不恢复旧任务。

## AI 安装流程

1. 先读 AGENTS.md。优先便携包，核对系统及 CPU，不覆盖现有钱包目录。
2. 先按 [WALLET_SETUP.md](WALLET_SETUP.md) 使用已知入口路径，或由 AI 自动生成公开入口清单。不要从头反复搜账号池。使用便携 Python 执行 setup.py，或双击启动入口。首次可用 `--no-wallet` 只装空看板，不调用任何钱包。源码安装才需要系统 Python 3.10+、Node 24+、npm。
3. 按返回的 `url` 访问页面，核验 bootstrap 的 installationId 与 `dataDir/install.json` 相同。不要输出 token、完整会话或 settings。把完整的 `http://127.0.0.1:端口/` 发给用户。
4. 查看 walletCount 和 issues，不把“页面打开”说成“钱包全部可用”。已有绑定在环境暂时故障时保留；实际连接实时检查。

## 钱包发现

只支持 Binance Agentic Wallet；不是任意钱包存储的读取器。搜索 Documents、Desktop、Projects 及已配置的 OneDrive Documents/Desktop；排除隐藏目录、AppData、Library、钱包凭据及浏览器目录。

支持任意目录中的 account1–200 启动脚本；accounts.json 可选，只读其公开绑定。其他名称、选择账号参数、指定解释器或 WSL 的入口使用 `--wallet-entry` / `--wallet-map`，见 WALLET_SETUP.md。执行官方 `wallet status --json` 与 `wallet address --json`，不更换编号、不读取 .baw、不绕过原入口的锁。没有已知入口时才尝试 PATH 中官方 baw CLI；指定账号池失败不会切换到默认钱包。

首次核验默认并发 4，总预算 30 秒；单账号超时不会阻止其他正常账号接入。再次启动复用绑定，`--recheck-wallets` 才重新核验。请检查 `issues` 和 `walletCheck`，不要因一个失败账号重复全套安装。

多套入口：先让用户选择目录，停止本安装后 `setup.py --wallet-dir "完整目录"`。目录不在默认范围时可用 `--scan-root "目录"`，可重复。`setup.py discover` 仅扫描文件名，不查询钱包。

没有钱包或需要登录时，按 Binance 官方技能由用户本人在 App 确认，绝不要求私钥、密码或登录凭据，不退出已有会话。完成后停止本安装，重新绑定。

## Windows 故障

- **WALLET_ENVIRONMENT_NOT_READY**：现有 Docker 编号钱包环境尚未运行。启动该钱包原有的专用启动入口或 Docker Desktop 后重试。不要反复安装 Docker、改注册表、重置数据卷、切换固定实例或停止其他软件。新看板不会自动尝试修复 Docker。
- **黑窗口反复弹出**：1.1 的 Node、Python、PowerShell 子进程均使用隐藏启动；断线检查采用退避。先停止旧 1.0 服务，再使用新入口。不要同时开旧看板与新看板的相同钱包。
- **fsync / EPERM**：1.1 改为同步写句柄，保留持久化与原子替换；新安装的数据默认写入 LocalAppData，避开 Documents 保护路径。不会通过关闭安全软件、放宽文件权限或忽略写入错误来继续交易。
- **入口无 JSON / 超时**：检查原钱包入口的 `--json` 输出和所需环境；看板不会展示可能含凭据的原始 stderr。
- **PowerShell 执行策略阻止**：由用户按所在环境的管理要求处理；安装器不修改系统执行策略。

## 数据与更新

新安装数据位于 Windows `%LOCALAPPDATA%/AgentTradeConsole/<安装目录标识>` 或 Mac `~/Library/Application Support/AgentTradeConsole/<安装目录标识>`。安装 JSON 返回确切 dataDir。已有 `local/install.json` 的旧安装继续使用原 local，保留地址、历史、稳定 ID。移动安装目录前先停止服务；不要同时启动同一钱包的多个安装。

更新前执行旧目录的 `setup.py stop`；若有待核对原单，先核对原单，不强杀、清空历史或换 ID 下单。随后在原安装目录更新源码/便携文件，保留数据。重新运行 setup.py。没有公开发布者的钱包映射，也不会向发布者上传数据；RPC、项目网站和 Binance 请求按功能执行。

再次分享只能发送原始 ZIP；不要压缩已使用的目录，也不要提交 dataDir、local、日志、钱包目录或环境文件。

## 可选专属内盘工具

Open Four 依赖使用者独立安装的官方只读工具 `agent-id-exclusive-token-launches.mjs`。可在 `.codex/skills`、`.agents/skills`、`.claude/skills` 的官方技能目录中发现，或在自己的 dataDir/install.json 设置绝对路径 openFourScript。公开版不复制未核实再分发许可的第三方工具。缺少该工具时对应专属内盘不可用，其他路线仍独立处理。

## 测试边界

CI 仅使用合成钱包，覆盖不同 OS、中文/空格路径、只读连接、重复安装、启动/停止和下载包。它不能替代用户实际 Docker、钱包登录、App 审批、网络与 Windows 桌面环境的验证。任何开发验证不执行真实交易。
