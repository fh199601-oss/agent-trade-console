# Agent 交易台 · 独立分享版

把原始 ZIP 发给能操作本机文件和终端的 AI，附这一句话：

> 请解压这个包并按 START_HERE.md 和 AGENTS.md 完成安装，自动查找我本机已有的 Binance Agentic Wallet 钱包入口，只读核验并绑定我的钱包，启动本地看板后把可点击的网址发给我；不要读取、导出或索要私钥、助记词、登录凭据，也不要做任何真实交易。

普通网页聊天如果没有本机文件/终端权限，无法替你安装。Codex、可运行本机命令的 Grok/其他 AI 可以按下列流程完成。

## AI 安装流程

1. 解压到使用者自己的固定目录，不覆盖现有交易台或钱包目录。阅读本包 AGENTS.md。
2. 检查 Python 3.10+、Node.js 24+、npm。缺失时从 [Python](https://www.python.org/downloads/) / [Node.js](https://nodejs.org/en/download) 或操作系统官方包管理器安装；保留现有钱包环境。
3. 在解压目录执行 `python3 setup.py`。Windows 可用 `py -3 setup.py`。脚本先校验发行文件，使用锁定依赖且禁用 npm 生命周期脚本，然后发现钱包、做只读核验并启动模拟看板。只需要网络下载依赖，不需要 API Key。
4. 读取返回的 `url`，打开/GET 该页面验证可用，把**实际返回的网址**发给用户。端口由系统分配，不固定 8797；不会连接或重启另一份交易台。网址仅此电脑可用，不要开放到公网。
5. 根据 `walletCount` 和 `issues` 如实处理。不能把“页面启动”说成“钱包已全部接入”。

若返回 `READ_ONLY_CHECK_FAILED`，AI 应读取该钱包工作区现有的 AGENTS/README，检查其所需 Docker/Colima/PowerShell 等环境，并仅重试只读连接查询；不能重建/清空钱包数据卷、退出登录或绕过原账号锁。`ADDRESS_MISMATCH` 表示绑定与实时钱包不同，先让用户确认目标钱包，不自动覆盖原公开绑定。

钱包发现仅支持 **Binance Agentic Wallet**，不是任意钱包文件的通用解密器：

- 优先搜索 Documents、Desktop、Projects 下已有 `wallet-containers/accounts.json` 与 `accountN.sh`（Windows 为 `.ps1`）；读取的 JSON 仅是公开地址映射。编号不重排，最多接入 1–5 号。保留原编号脚本及跨聊天锁，Mac 编号入口使用现有 Colima 环境。
- 目录不在默认范围：`python3 setup.py --wallet-dir "完整的钱包目录"`；可重复 `--scan-root "工作区目录"` 限定查找范围。`discover` 命令仅列候选目录，不调用钱包。
- 多套钱包入口：安装器启动空看板并返回候选目录，AI 请用户选哪套，再 `stop` 和带 `--wallet-dir` 重新安装。不能自动合并同名账号。
- 无编号钱包时尝试 PATH 中现有 `baw` 官方 CLI，仅 `wallet status --json` 和 `wallet address --json`，将唯一已连接的 BSC 地址绑定为 1 号。已有编号目录却断线时不会偷偷改用默认钱包。
- 没有 CLI 或未连接：先把已启动的看板网址发给用户，再按 [Binance 官方技能](https://github.com/binance/binance-skills-hub) 安装/登录。App 确认须由用户完成；不要索取私钥，不要退出其他账号。之后 `stop`，再 `setup.py --wallet-dir ...`；没有编号入口且原来为空绑定时，`stop` 后直接重新运行 `setup.py` 即可。

仅装空看板：`python3 setup.py --no-wallet`。这不会搜索或调用钱包。

## 启停与 AI 调用

```text
python3 setup.py status
python3 setup.py stop
python3 setup.py start
python3 agent_trade.py --url example.com --preflight
python3 agent_trade.py --url example.com --scope free --shares max
python3 agent_trade.py --ca <代币CA> --side sell --percent 50 --account 1
```

以上默认模拟/预览。准备好后，**使用者另行明确要求**启用真实交易时，先停止本安装，再 `python3 setup.py start --live`。实盘 `--go` 仍要求稳定 `--id`、当前用户 `--authorization`，并经过服务端预览。看板开启的开盘自动卖出也必须由使用者选择 CA、钱包和比例后启动。安装器不自动授权、不自动交易、不创建开机任务。

网址识别、链上 Mint 回查、免费/付费额度、邀请、快捷买卖和开盘自动卖出保留在这份独立代码里。历史经验库从空白开始；不附带任何发布者交易历史、参考钱包、推荐链接或个性化按钮配置。特殊合约/过期项目/网络故障仍可能无法预览，不能保证所有网站通用或固定成交速度。

## 文件和隐私

原始 ZIP 仅含程序、静态 UI、锁定依赖清单、说明和测试。**不含账户绑定、钱包存储、私钥、助记词、登录状态、个人环境文件或历史记录。** 合约/路由器等公开协议地址是代码的一部分，不能据此操作发布者钱包。

安装产生的 `local/` 属于使用者自己：包括公开钱包映射、入口路径、本地服务身份、订单/预览记录和日志。包本身不设置遥测或向发布者回传数据；查询区块链、行情及官网时会按功能访问公开 RPC、项目网站及 Binance 服务。签名留在使用者已有官方钱包入口。

要转发给别人，只转发最初的 ZIP 和校验文件。**不要转发已经运行过的目录**。

Mac 已做隔离安装验证；Windows/Linux 提供兼容入口，但本次没有在对应实机完成端到端验证。PoW 原生加速需要可用的 C 编译器，不可用时按现有回退/错误提示处理。

## 校验与故障

`python3 setup.py verify` 校验代码清单。ZIP 旁的 `.sha256` 可用于下载完整性校验；校验和不是第三方安全审计或作者数字签名。安装后停止服务再移动目录，重新 `setup.py` 更新运行环境。

端口/服务身份不符时停止连接，不影响别的服务；App 登录过期时重新走官方登录；缺少钱包入口时报告路径/依赖问题，绝不转而读取凭据。开发测试见 `python3 -m unittest discover -s tests -v`，只使用临时假钱包，不需要接触真实资金。

## 开源版可选工具

Open Four 专属内盘依赖使用者另外安装的官方只读工具 `agent-id-exclusive-token-launches.mjs`。本仓库不复制该工具源码；会在使用者的 `.codex/skills`、`.agents/skills` 或 `.claude/skills` 下查找，亦可在自己的 `local/install.json` 设置绝对路径 `openFourScript`。缺少该工具时无法使用此专属内盘适配，普通聚合交易与其他已支持路线不受此依赖影响。没有接入看板的 BBF 连续批次辅助代码未包含在公开版本中。
