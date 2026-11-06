# AGENT · 本地交易台

面向 Grok、Codex 等本地 AI 的 BNB Chain 项目 Mint 与交易看板。**1.1 起用户入口只有真实交易模式**；识别、余额查询、交易预览仍只读，安装和打开网页不会下单。每笔交易需要用户本次操作或明确指令。

## 最简单的使用方式

从 [Releases](https://github.com/fh199601-oss/agent-trade-console/releases/latest) 下载对应系统的 **便携 ZIP**，完整解压后：

| 系统 | 下载包后缀 | 双击启动 |
| --- | --- | --- |
| Windows 10/11，普通 Intel/AMD 电脑 | `windows-x64.zip` | `Start.vbs` |
| Windows 11，ARM 电脑 | `windows-arm64.zip` | `Start.vbs` |
| Mac，Apple 芯片 | `macos-arm64.zip` | `Start.command` |
| Mac，Intel 芯片 | `macos-x64.zip` | `Start.command` |

便携包自带固定版本的 Python、Node 和 npm 依赖，**不用手动安装 Python、Node、npm 或 Git**，也不修改系统 PATH。启动时先显示进度，再打开实际看板地址。Windows 钱包查询在后台静默运行。不要选 GitHub 自动生成的 Source code ZIP，那是开发用源码包。

**1.5 起首次安装默认配置登录自启，并创建桌面 `AGENT-xxxxxx` 一键入口。** 重启并登录电脑后后台启动，点击桌面入口即可打开本安装的实际网址；重复点击不会重启服务。Mac 使用 LaunchAgent，Windows 使用当前用户的启动目录和隐藏进程，不需要管理员权限。原自动领取、卖出任务继续保持重启后暂停，由本人恢复。自启关闭、旧版补装和钱包环境边界见 [STARTUP.md](STARTUP.md)。

看板不是钱包客户端：仍需要你自己已连接的 Binance Agentic Wallet。现有编号入口如果依赖 Docker，Docker 必须正常运行；看板不会重新注册、重置或反复启动 Docker。直接使用官方 CLI 的用户不因看板而需要 Docker。

## 发给 AI 的安装提示词

```text
请安装 https://github.com/fh199601-oss/agent-trade-console 最新 Release 中适合我 Windows/Mac 和芯片的便携包，先读 AGENTS.md、START_HERE.md、STARTUP.md、WALLET_SETUP.md 和 WALLET_SAFETY.md。找到已有钱包/账号池的公开启动入口，先确认原主机、容器或 WSL 环境，再用 --wallet-dir、--wallet-entry 或按文档生成的 --wallet-map 接入，保留原 CLI、解释器、账号选择和锁。包内运行环境只运行看板，绝不能用主机或其他版本 CLI 打开容器登录目录，不安装升级钱包 CLI，不复制会话、不重建容器。已有绑定直接复用，失败按 issues 定点处理，不反复搜索或重装；原环境无法确认时先开空看板并说明原因。启用登录自动启动并创建桌面一键入口，核验安装结果的 startup 字段；自动领取、卖出任务不自动恢复。打开并验证页面和只读连接，把含端口的完整网址及接入结果发给我。安装测试不得买卖、Mint、授权、签名或启动自动交易，不得读取、复制、导出或索要私钥、助记词、登录凭据；确认确需 App 登录或多套账号池范围不明确时才让我操作。
```

## 功能

- 官网 / 域名 / CA 识别，区分地址用途，结合 ABI、源码与链上成功样本识别 Mint。
- 免费 / 付费 / 全部额度、预算检查、邀请识别与官方交易预览。不同钱包绑定的签名、证明和资格不能直接复制别人交易。
- [Corla 快速认购](CORLA.md)：网址和 CA 优先识别、`max` 额度与预算、开盘自动领取，以及可选的领取后按比例卖出。
- 5 个自定义买入按钮、5 个按**实时剩余持仓**计算的卖出按钮。
- 开盘自动卖出必须由用户选择 CA、钱包、比例后启动；服务重启暂停旧任务。
- [任务中心](TASKS.md)按代币分组，支持暂停、恢复、删除、修改尚未提交的卖出比例，以及为近期 Mint 的未开盘项目补建自动领取／卖出任务。
- 未知免费额度可在适配入口从最多 10 份向下只读试算；免费默认打满，付费数量支持“全部打满”按钮和不区分大小写的 `max`。
- 可设置自己的 BSC 查询 RPC，失败切换公共节点；签名广播仍由官方钱包服务完成。右上角可检查 GitHub 正式发行版更新。
- 稳定订单 ID、防重复提交、历史经验与耗时记录。未知提交结果只核对原单。

不能保证每个项目、池子或开盘时间都支持。未验证的目标、失败的预览和钱包硬拦截不会被跳过。

最新变化见 [CHANGELOG.md](CHANGELOG.md)。明确未成交且符合恢复条件的领取／卖出可以有限重试；提交结果不明时只核对原单，避免重复扣款。

## 源码安装与 AI 调用

源码用户需 Python 3.10+、Node.js 24+ 与 npm，执行 `python3 setup.py`（Windows：`py -3 setup.py`）。便携版使用 `portable/python/python.exe setup.py`（Windows）或 `./portable/python/bin/python3 setup.py`（Mac）。

安装结果为 JSON：`url`、`mode`、`walletCount`、`issues`、`walletCheck`、`dataDir`。`walletCount` 是保存的绑定数；实际连接以看板 / `issues` / 官方 CLI 为准。已知路径直接绑定，未知路径最多一次限时发现；多套入口需明确范围。不同账号池、任意脚本名与 1–200 号接入见 [钱包快速接入](WALLET_SETUP.md)。默认 4 个独立钱包并行，总核验预算 30 秒，故障账号单独报告；不是整个下载或登录流程的耗时保证。

```bash
python3 setup.py --wallet-dir "已有钱包工作区"
python3 setup.py --wallet-map "公开清单的完整路径/wallet-entrypoints.json"
python3 setup.py status
python3 setup.py stop
python3 setup.py start
python3 agent_trade.py --url example.com --preflight
python3 agent_trade.py --ca <TOKEN_CA> --side sell --percent 50 --account 1
```

AI 交易脚本没有 `--go` 时只预览；提交须同时提供稳定 `--id` 和本次 `--authorization`。真实交易模式不等于允许安装 AI 自动测试下单。

## 开发与验证

```bash
python3 -m unittest discover -s tests -v
cd trade-console
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

GitHub Actions 在 Windows x64 / ARM64、Mac Intel / Apple 芯片环境中运行测试、假钱包全流程检查、便携包构建与解压复测。以 [实际运行结果](https://github.com/fh199601-oss/agent-trade-console/actions) 为准；CI 不代表已验证所有真实 Docker 安装、钱包会话或桌面安全软件。

自有代码采用 [MIT](LICENSE)，运行时和其他依赖保留各自许可，见 [THIRD_PARTY.md](THIRD_PARTY.md)。请只分享原始发行包，不分享使用后的数据目录；问题反馈不要附凭据，见 [SECURITY.md](SECURITY.md)。
