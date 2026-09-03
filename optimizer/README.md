# 本地 FSRS 计算模块

官方来源：https://github.com/open-spaced-repetition/fsrs-rs 。固定使用 `fsrs = 6.6.2`，依赖版本见 `Cargo.lock`。参数训练、历史评估、时间分段评估、模拟和记忆率搜索均调用该 crate；排程由已有的 `ts-fsrs 5.4.1` 执行。

`assets/optimizer.wasm` 是 `wasm32-wasip1` 发布构建，普通 `npm run build` 将它和 `worker.cjs` 嵌入 `main.js`。运行不需要额外二进制、网络或用户机器上的 Rust。

## 运行适配

Obsidian 的 Electron renderer 不能创建 Node worker_threads。实际插件使用 Web Worker，在独立线程运行 WASI 可执行文件。`worker.cjs` 实现本模块实际导入的 8 个 WASI preview1 函数：随机数、环境大小／读取、时钟、标准输入／输出、退出和让出调度。没有文件系统目录、网络或环境变量传入。Node bridge 仅供命令行冒烟验证。

WASI 单线程环境下，原 Rayon 的 spawn 与等待通道会死锁。`serial-rayon/` 仅将当前依赖用到的 spawn、迭代调度替换为当前工作线程的串行执行；未修改 FSRS 数学、训练或模拟逻辑。若升级 crate 或新增 Rayon 使用方式，必须重新审查接口和回归测试。

## 重建

使用支持 Rust edition 2024 的工具链，安装 `wasm32-wasip1` target：

```sh
rustup target add wasm32-wasip1
cargo build --locked --manifest-path optimizer/Cargo.toml --release --target wasm32-wasip1
cp optimizer/target/wasm32-wasip1/release/review-center-optimizer.wasm assets/optimizer.wasm
npm run build
node scripts/check-optimizer.mjs
```

开发中可将 `CARGO_HOME` 与 `RUSTUP_HOME` 指向本仓库 `.build-tools/` 内的专用目录，避免修改全局工具链。构建产物随源码记录；Rust 构建目录不进入安装包。

`check-optimizer.mjs` 使用 80 个项目、400 条跨日评分验证训练、评估、健康检查和 7 档记忆率模拟。普通 Node 验证通过后仍须在真实 Obsidian 中运行优化、模拟、取消与草稿保存测试，因为两者的工作线程环境不同。

fsrs 的 BSD-3-Clause 许可证全文随分发包附在 `THIRD_PARTY_NOTICES.txt`。
Rust 和 JavaScript 依赖的许可证一并包含。其中 priority-queue 2.7.0 选择 MPL-2.0 许可分发，未修改的对应源码随包附在 `priority-queue-2.7.0-source.zip`。
