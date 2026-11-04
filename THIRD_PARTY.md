# 第三方依赖与参考

本项目自己的代码按根目录 LICENSE 的 MIT 许可发布。第三方包保留自己的许可，安装时由 npm 获取，不把其许可改写为本项目许可。

## npm 依赖

版本、下载地址及完整性散列见 `trade-console/package-lock.json`。直接依赖包括 ethers、undici、acorn、@solidity-parser/parser、@noble/hashes，锁定版本所声明的许可均为 MIT。传递依赖 tslib 使用 0BSD；其余锁定传递依赖声明为 MIT。包内完整许可随 npm 安装提供。

## 预检流程参考

历史经验、并行读取、模拟与耗时记录等流程参考了 [0xMulight/bsc-mint-preflight](https://github.com/0xMulight/bsc-mint-preflight)。其 MIT 声明保留在 [licenses/bsc-mint-preflight-MIT.txt](licenses/bsc-mint-preflight-MIT.txt)。没有附带作者或发布者的运行记录。

## 独立安装的官方工具

Open Four 的可选桥接调用使用者另外安装的 `agent-id-exclusive-token-launches.mjs`。该工具的分发和许可由其原提供方负责，本仓库不包含该文件。官方技能入口：[Binance Skills Hub](https://github.com/binance/binance-skills-hub)。

公开版不包含原分享快照中的 `bbf-preview.mjs` 及未接入看板的 BBF 连续批次辅助文件。未核实明确再分发许可的第三方源码不随本仓库发布。
