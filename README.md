# 视频缓冲扩容（油猴脚本）

一个 Tampermonkey 用户脚本：**把 hls.js / dash.js 播放器的前向缓冲从默认 ~30 秒扩到 3 分钟**，解决网速稍有抖动、播放进度就追上缓冲线导致的卡顿。

当前适配站点：`ani.girigirilove.com`（含播放器所在的 `pl.girigirilove.com` 子域）。

## 原理

网页视频播放器（hls.js / dash.js 这类 MSE 播放器）默认只向前缓冲 30 秒左右。只要这 3 分钟内网速出现波动，播放进度就会贴上缓冲墙，产生卡顿。

本脚本的做法是**接管播放器自身的配置**：

- 拦截页面的 `Hls` / `dashjs` 全局变量（`@run-at document-start` + `defineProperty` 赋值钩子）
- 包裹构造函数，强制注入缓冲参数（即使站点显式传了配置也会被覆盖）：
  - `maxBufferLength`: 180s（前向缓冲目标）
  - `maxMaxBufferLength`: 540s（上限）
  - `maxBufferSize`: 300MB（hls.js 默认仅 60MB，会提前掐断缓冲）
- 数据走**播放器自己的网络栈**（Cookie / Referer / 防盗链签名全部原装），进入**播放器自己的 MSE buffer**（必定被播放使用）

与"旁路预下载塞 HTTP 缓存"类扩展（如 VideoBoost）的区别：那条路命中不可靠、有防盗链失败、会重复下载；本方案改的是播放器的下载计划，确定性更高。

## 安装

1. Edge / Chrome 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. **必须开启浏览器「开发人员模式」**（Edge 120+ / Chrome 120+ 强制要求，否则用户脚本静默不注入）：
   - Edge：`edge://extensions/` → 打开「开发人员模式」
   - Chrome：`chrome://extensions/` → 打开「开发者模式」
3. Tampermonkey 图标 → 「添加新脚本」→ 全选删除模板 → 粘贴 `video-buffer-booster.user.js` 全部内容 → Ctrl+S 保存
4. 打开（或刷新）视频页生效

## 控制台日志

F12 打开控制台，所有日志带**橙色 `缓冲扩容` 标签**：

| 时机 | 消息 |
|---|---|
| 页面加载 | `脚本已注入（仅本站生效），正在监听 Hls / dashjs 全局变量…` |
| 播放器被接管 | `hls.js 已接管：前向缓冲 180s / 上限 300MB` |
| 实例创建 | `已接管第 N 个 hls.js 实例` |
| 每 10 秒 | `第1个视频 · 进度 3:27 · 前方缓冲 214.6s（目标 180s 的 100%）` |

**效果判定**：「前方缓冲」超过 30 秒且持续增长 = 生效。

## 配置

修改脚本头部常量后保存即可：

```js
const BUFFER_AHEAD = 180;   // 前向缓冲目标（秒），内存紧张可降到 60~120
const MAX_BUFFER_MB = 300;  // 缓冲总大小上限（MB）
const FORCE_HD = false;     // true = 强制锁定最高清晰度（流量大增）
```

## 适配新站点

脚本的 `@match` 只放行白名单站点。给新站点启用时需确认播放器结构：

1. 播放页 F12 控制台输入 `Hls` 回车——是对象 → 直接把该站域名加进 `@match`
2. 是 `undefined` → 播放器可能嵌在 iframe 里（检查 `<iframe>` 的 src 域名，把子域也加进 `@match`），或 hls.js 被打包进模块内部（需要换 MediaSource 层钩法）

## 已知边界

- **只对 hls.js / dash.js 播放器生效**，且要求库以全局变量形式暴露；浏览器原生 HLS、DRM 加密内容（Netflix、爱优腾等）、自研播放器无效果
- **只治短时网速波动**：如果平均带宽低于视频码率，缓冲再大也终会追上——彻底方案是把 m3u8 链接复制下来用 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE) 整集下载后本地观看
- **内存代价**：MSE buffer 常驻内存，3 分钟 1080p 约 100~200MB；机器内存紧张就把 `BUFFER_AHEAD` 调低

## 文件结构

```
├── video-buffer-booster.user.js   # 脚本本体（Tampermonkey）
└── README.md
```

## 版本记录

| 版本 | 内容 |
|---|---|
| 0.2.0 | 默认前向缓冲降为 180s / 上限 300MB；@match 精确到 ani + pl 两个子域；新增橙色标签控制台日志与每 10s 缓冲监控 |
| 0.1.0 | 初版：hls.js / dash.js 构造函数包裹，强制注入缓冲参数 |
