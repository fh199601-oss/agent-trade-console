# Agent Trade Console

面向 Grok、Codex 等本地 AI 的 BNB Chain 项目 Mint 与交易看板。默认只读预览和模拟；钱包签名通过使用者已有的 Binance Agentic Wallet 官方入口完成。

**不包含作者的钱包地址、登录会话、私钥、助记词或历史交易数据。**

## 一句话让 AI 安装

将下面这句话发给能操作你本机文件和终端的 AI：

> 请下载 https://github.com/fh199601-oss/agent-trade-console ，按照 START_HERE.md 和 AGENTS.md 完成安装，只读查找并绑定我自己本机的 Binance Agentic Wallet 钱包入口，启动本地看板后把可点击的网址发给我。不要读取、导出或索要私钥、助记词、登录凭据，不要进行真实交易。

AI 需要本机终端权限。钱包未登录时，仍需使用者通过币安 App 完成官方登录确认。

## 功能

- 支持项目网址、裸域名及 CA 输入，识别地址用途、Mint 方法、免费/付费额度和邀请方式。
- 识别不足时，回查链上成功 Mint 记录；目标、参数、额度和钱包资格仍需验证。
- 本地交易看板、持仓与行情、可自定义的五个买入金额按钮和五个卖出比例按钮。
- 卖出比例按每次操作时的剩余持仓计算；支持由用户手动启动的单次开盘自动卖出。
- Grok / Codex 共用 CLI 与 JSON 输出；稳定操作 ID、防重复提交、原单跟踪。
- 多钱包入口隔离、地址交叉核验、会话恢复、独立本地服务身份。

Mint 方式、网站接口和池子差异很大；本项目不保证所有项目通用，也不保证固定成交时间。新钱包的历史经验库为空，运行后在其本机逐步积累。

## 手动安装

需要 Python 3.10+、Node.js 24+ 和 npm，以及你自己的 Binance Agentic Wallet 环境。

```bash
git clone https://github.com/fh199601-oss/agent-trade-console.git
cd agent-trade-console
python3 setup.py
```

Windows 可使用 `py -3 setup.py`。脚本输出 JSON，其中 `url` 是本机网页地址，`walletCount` 是实际通过核验的钱包数，`issues` 说明未接入的原因。首次启动为 **SIMULATION**。

只启动空看板：`python3 setup.py --no-wallet`。指定现有钱包入口：`python3 setup.py --wallet-dir "钱包工作区或 wallet-containers 目录"`。

支持官方 CLI 和 account1–account5 的 `.sh` / `.ps1` 编号入口；不会解析任意钱包存储文件。自动发现多个钱包工作区时，请先选择目标目录。详细流程和故障处理见 [START_HERE.md](START_HERE.md)。

## 使用与启停

```bash
python3 setup.py status
python3 setup.py stop
python3 setup.py start
python3 agent_trade.py --url example.com --preflight
python3 agent_trade.py --url example.com --scope free --shares max
python3 agent_trade.py --ca <TOKEN_CA> --side sell --percent 50 --account 1
```

以上默认只读/模拟。只有使用者明确要求启用真实交易后，才运行 `python3 setup.py start --live`；切换模式前先停止本安装。实盘 CLI 需要 `--go`、稳定 `--id` 和当前用户的 `--authorization`，仍须通过交易预览。安装行为不授权测试下单。

## 适配与许可边界

Open Four 专属内盘适配会调用使用者独立安装的官方只读工具；该工具源码不在本仓库内。缺少工具时，这条专属路线不可用。未接入看板的 BBF 连续批次专用辅助代码也不包含在公开版本中。普通 Mint、聚合交易及其他已支持路线保留。

本项目代码采用 [MIT](LICENSE)。第三方依赖和预检流程参考说明见 [THIRD_PARTY.md](THIRD_PARTY.md)。本项目为独立项目，不代表 Binance 官方。

## 开发与隐私

```bash
python3 -m unittest discover -s tests -v
cd trade-console
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

这些测试使用合成数据，不需要真实钱包。Mac 已做隔离验证；Windows/Linux 尚未在对应实机完成全流程验证。

修改源码后运行 `python3 tools/update_manifest.py` 更新安装校验清单。不要将 `local/`、任何钱包目录、环境文件、日志或使用后的目录加入 Git。每次发布前检查 `git diff --cached`。提交问题时也不要附上凭据或完整运行目录，见 [SECURITY.md](SECURITY.md)。
