// ==UserScript==
// @name         视频缓冲扩容（hls.js / dash.js）
// @namespace    vb-buffer-booster
// @version      0.2.0
// @description  把 hls.js / dash.js 播放器的前向缓冲从默认 ~30 秒扩到 10 分钟，解决网速抖动追上缓冲导致的卡顿。数据走播放器自身网络栈，无防盗链问题，进 MSE buffer 必定被播放使用。
// @match        *://ani.girigirilove.com/*
// @match        *://pl.girigirilove.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ===== 可调参数（按需修改）===== */
  const BUFFER_AHEAD = 180;              // 前向缓冲目标（秒）。180 = 3 分钟。内存紧张可降到 60~120
  const MAX_BUFFER_MB = 300;             // 缓冲总大小上限（MB）。hls.js 默认仅 60MB，会提前掐断缓冲
  const FORCE_HD = false;                // true = 强制锁定最高清晰度（流量大增，默认关）
  /* ============================= */

  /* ===== 控制台日志：带彩色标签前缀，突出显示 ===== */
  const TAG = '%c缓冲扩容';
  const STYLE = 'color:#fff;background:#e67e22;padding:1px 6px;border-radius:3px;font-weight:bold';
  function log(msg) { console.log(TAG, STYLE, msg); }
  let instCount = 0; // 已接管的播放器实例计数

  /* ===== 缓冲监视器：每 10 秒打印一次视频前方缓冲量，直观验证效果 ===== */
  setInterval(function () {
    var vids = document.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      if (!v.duration || v.readyState < 2) continue;
      // 找 currentTime 所在或其后的缓冲区间，算前方缓冲秒数
      var ahead = 0;
      for (var j = 0; j < v.buffered.length; j++) {
        if (v.buffered.start(j) <= v.currentTime && v.currentTime < v.buffered.end(j)) {
          ahead = v.buffered.end(j) - v.currentTime;
          break;
        }
      }
      var min = Math.floor(v.currentTime / 60), sec = Math.round(v.currentTime % 60);
      var pct = Math.min(100, Math.round(ahead / (BUFFER_AHEAD) * 100));
      log('第' + (i + 1) + '个视频 · 进度 ' + min + ':' + (sec < 10 ? '0' : '') + sec +
          ' · 前方缓冲 ' + ahead.toFixed(1) + 's（目标 ' + BUFFER_AHEAD + 's 的 ' + pct + '%）');
    }
  }, 10000);


  // hls.js 运行时读取的配置项，构造实例时合并进去（覆盖播放器显式传的值）
  const HLS_PATCH = {
    maxBufferLength: BUFFER_AHEAD,       // 前向缓冲目标时长（默认 30s）
    maxMaxBufferLength: BUFFER_AHEAD * 3,// 缓冲上限时长
    maxBufferSize: MAX_BUFFER_MB * 1000 * 1000, // 缓冲字节上限（默认 60MB）
  };

  // 包一层 Hls 构造函数：无论播放器传什么配置，我们的缓冲参数都生效
  function patchHls(Hls) {
    if (!Hls || Hls.__bufferPatched) return Hls;
    try {
      // 1) 默认配置兜底（播放器没显式传的 key 走这里）
      if (Hls.DefaultConfig) Object.assign(Hls.DefaultConfig, HLS_PATCH);

      // 2) 包构造函数（播放器显式传了 maxBufferLength 也会被覆盖）
      const Wrapped = function (cfg) {
        const merged = Object.assign({}, cfg || {}, HLS_PATCH);
        const inst = new Hls(merged);
        instCount++;
        log('已接管第 ' + instCount + ' 个 hls.js 实例' + (FORCE_HD ? '，并锁定最高清晰度' : ''));
        if (FORCE_HD) {
          try {
            inst.on(Hls.Events.MANIFEST_PARSED, function () {
              inst.currentLevel = inst.levels.length - 1; // levels 按码率升序，最后一个是最高档
            });
          } catch (e) {}
        }
        return inst;
      };
      // 静态成员拷贝：isSupported / Events / ErrorTypes / version / DefaultConfig 等
      const names = Object.getOwnPropertyNames(Hls);
      for (const k of names) {
        try {
          Object.defineProperty(Wrapped, k, Object.getOwnPropertyDescriptor(Hls, k));
        } catch (e) {}
      }
      Wrapped.prototype = Hls.prototype; // 保持 instanceof 兼容
      Wrapped.__bufferPatched = true;
      log('hls.js 已接管：前向缓冲 ' + BUFFER_AHEAD + 's / 上限 ' + MAX_BUFFER_MB + 'MB');
      return Wrapped;
    } catch (e) {
      log('hls.js 接管失败：' + (e && e.message));
      return Hls;
    }
  }

  // dash.js 播放器（少数站用）：包 MediaPlayer 工厂的 create，注入缓冲设置
  function patchDash(dash) {
    if (!dash || dash.__bufferPatched || !dash.MediaPlayer) return dash;
    try {
      const Factory = dash.MediaPlayer;
      const WrappedFactory = function () {
        const api = Factory();
        const origCreate = api.create;
        api.create = function () {
          const inst = origCreate.apply(api, arguments);
          try {
            inst.updateSettings({
              streaming: {
                buffer: {
                  stableBufferTime: 60,
                  bufferTimeAtStartPlayback: 20,
                  bufferTimeAtTopQuality: BUFFER_AHEAD,
                  bufferTimeAtTopQualityLongForm: BUFFER_AHEAD * 1.5,
                },
              },
            });
          } catch (e) {}
          return inst;
        };
        return api;
      };
      WrappedFactory.prototype = Factory.prototype;
      dash.MediaPlayer = WrappedFactory;
      dash.__bufferPatched = true;
      log('dash.js 已接管');
      return dash;
    } catch (e) {
      return dash;
    }
  }

  // 在全局变量被赋值的瞬间拦截（document-start 时 Hls 可能还没加载）
  function hookGlobal(name, patcher) {
    try {
      const cur = window[name];
      if (cur) { window[name] = patcher(cur); return; }
      let val;
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return val; },
        set: function (v) { val = patcher(v); },
      });
    } catch (e) {}
  }

  hookGlobal('Hls', patchHls);
  hookGlobal('dashjs', patchDash);
  log('脚本已注入（仅本站生效），正在监听 Hls / dashjs 全局变量…');
})();
