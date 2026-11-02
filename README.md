# DSH 插件台

管理 DeepSeek Harness（DSH）各 profile 已装插件的独立桌面工具。

## 它解决什么

DSH 的插件装在 `~/.dsh/profiles/<profile>/` 里，靠 `package.json` 的 `dependencies` 与
`dsh.profile.bundles` 两个地方共同决定「装了什么」和「加载了什么」。命令行上要改这两处得手动编辑
JSON、手动跑 pnpm，还得自己记住哪个包在 bundles 里的哪个位置。

这个工具把这件事变成一个界面：

1. **看清现在装了什么** —— 列出每个 profile 的插件、真实版本、来源类型（npm / link / file / git / tarball）、
   是否在 `bundles` 里被加载、是否被 `cordis.patch.yml` 外部停用。
2. **检查并执行更新** —— 逐包对比 npm registry 上的 latest，标出可更新的；支持单个更新和全部更新。
3. **卸载** —— 两步确认；官方内置层（`@deepseek-ai/*`）受保护。
4. **自定义安装** —— 粘贴 GitHub 仓库 URL、`owner/repo`、npm 包名、`包名@版本`、tarball URL 或
   `link:路径`，实时预检（识别来源 → 归一化成 pnpm spec → 拉远端元数据 → 提示会不会被加载），
   确认后安装并自动写回 `bundles`。
5. **插件市场** —— 接入 dsh-market 目录（8000+ 条目），宫格浏览、搜索、详情与截图，
   支持选任意版本安装 / 降级（npm 走 dist-tag 与版本列表，git 走 tag / 分支列表）。
6. **环境自适应** —— DSH 没装、装在奇怪的位置、或者刚换新电脑：注册表 / 运行中的进程 /
   快捷方式 / 磁盘扫描多级探测，找到就自动用；node / pnpm 缺失时自动改用插件台自带的
   运行时（`resources/pnpm` + Electron 当 node），装插件不受影响。

## 它怎么工作

不重新发明轮子：底层就是在 profile 目录里跑 DSH 自带的 pnpm，然后同步簿记文件。

```
探测 DSH 环境 (DSH_HOME / 安装根 / 自带 node+pnpm)
        │
        ├─ 读 <profile>/package.json           → dependencies（装了什么）
        ├─ 读 <profile>/node_modules/<pkg>/    → 真实版本 / 描述 / 元数据
        ├─ 读 <profile>/cordis.patch.yml       → 外部停用状态（只读）
        └─ 读 <profile>/.dsh-console/state.json → 本工具记录的停用态
        │
        ├─ 更新检查：GET registry.npmjs.org/<pkg> 比 latest
        │
        └─ 写操作：node <自带pnpm.cjs> add/remove ... --dir <profile>
                   + 同步 dsh.profile.bundles（保序）
                   + 改前自动备份 package.json 到 .dsh-console/backup/
```

改完 profile 需要重启 DSH 才生效，界面上会提示并给一键重启。

## 开发

```bash
# 装依赖
pnpm install

# 开发（electron-vite 起渲染进程 dev server + 拉起 Electron）
pnpm dev

# 类型检查
pnpm typecheck

# 打包 NSIS 安装包 → release/
pnpm dist

# 只产出解包目录（不生成安装包）
pnpm dist:dir
```

## 环境要求

- Windows x64 —— 只有这一条是硬性的。
- **没装 DSH 桌面端也能用**：装插件走插件台自带的运行时（`resources/pnpm` + Electron 以
  node 方式运行），不需要系统 Node、不需要 DSH。
- 装了 DSH 桌面端则解锁：随包运行时（`~/.dsh/dsh-runtimes`）优先使用、
  「启动 / 退出 DSH」按钮（安装目录由多级探测自动识别 —— 注册表、运行中的进程、快捷方式、磁盘扫描）。

## 目录

```
src/
  shared/        主进程与渲染进程共享的类型与 IPC 契约（唯一真相）
  main/          主进程：窗口、IPC 注册
    engine/      引擎：环境探测 / 清单 / registry / 更新 / pnpm 执行 / bundles 簿记
  preload/       contextBridge 桥接
  renderer/      React 界面
docs/            设计文档、逆向分析与项目报告（report/01–07）
scripts/         探测 / 验收脚本与打包脚本（package.ps1）
```
