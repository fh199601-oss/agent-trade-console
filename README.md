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

看板不是钱包客户端：仍需要你自己已连接的 Binance Agentic Wallet。现有编号入口如果依赖 Docker，Docker 必须正常运行；看板不会重新注册、重置或反复启动 Docker。直接使用官方 CLI 的用户不因看板而需要 Docker。

## 发给 AI 的安装提示词

```text
请安装 https://github.com/fh199601-oss/agent-trade-console 最新 Release 中适合我系统和芯片的便携包，先读 README.md、START_HERE.md、AGENTS.md，完整解压并核验文件。优先使用包内运行环境，不要让我手动装 Python/Node，也不要修改现有钱包或 Docker。只通过我已有的官方 CLI 或编号钱包入口核验并接入钱包，多套入口先让我选择；需要登录时由我在币安 App 确认。启动真实交易看板，验证网页、钱包连接和余额读取，并把包含端口的完整看板网址发给我。安装与验证不得买卖、Mint、授权或签名，不得读取、导出或索要私钥、助记词、登录凭据。遇到失败请报告具体原因，不反复拉起黑窗口。
```

## 功能

- 官网 / 域名 / CA 识别，区分地址用途，结合 ABI、源码与链上成功样本识别 Mint。
- 免费 / 付费 / 全部额度、预算检查、邀请识别与官方交易预览。不同钱包绑定的签名、证明和资格不能直接复制别人交易。
- 5 个自定义买入按钮、5 个按**实时剩余持仓**计算的卖出按钮。
- 开盘自动卖出必须由用户选择 CA、钱包、比例后启动；服务重启暂停旧任务。
- 稳定订单 ID、防重复提交、历史经验与耗时记录。未知提交结果只核对原单。

不能保证每个项目、池子或开盘时间都支持。未验证的目标、失败的预览和钱包硬拦截不会被跳过。

## 源码安装与 AI 调用

源码用户需 Python 3.10+、Node.js 24+ 与 npm，执行 `python3 setup.py`（Windows：`py -3 setup.py`）。便携版使用 `portable/python/python.exe setup.py`（Windows）或 `./portable/python/bin/python3 setup.py`（Mac）。

安装结果为 JSON：`url`、`mode`、`walletCount`、`issues`、`dataDir`。`walletCount` 是保存的绑定数；实际连接以看板 / `issues` / 官方 CLI 为准。只有唯一入口会自动绑定；多套入口需选择。使用方式详见 [START_HERE.md](START_HERE.md)。

```bash
python3 setup.py --wallet-dir "已有钱包工作区"
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
