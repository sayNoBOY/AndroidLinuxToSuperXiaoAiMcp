/**
 * 网络状态探测（离线检测 → 恢复回调）。
 *
 * 背景：`mimo run` 依赖模型 API 出网。断网时子进程往往卡在出网请求上既不
 * 产出 NDJSON 事件也不退出，任务永远停在 running（TaskApi 无执行超时，是
 * 既定设计，不能靠"跑太久就杀"来兜底）。因此把"网络通断"本身作为信号：
 *   离线 → 标记、挂起派发；恢复 → 回调，让在执行/排队中的任务继续跑。
 *
 * 探测方式（不依赖任何第三方包，离线环境可用）：
 *   - `net.connect` 并发连一组 host:port，任一连通即在线；
 *   - 同时 `dns.lookup` 一个域名，解析成功也视为在线。
 * 任一成功 → online；全部失败 → offline。为避免抖动，连续 failThreshold 次
 * 失败才判定离线（1 次成功即判在线）。
 *
 * 用法：
 *   const w = createNetworkWatcher({ onOnline, onOffline, onChange });
 *   w.start();            // 立即探测一次，之后按 interval 轮询
 *   w.isOnline();         // 当前状态（初始 true，首帧探测后校正）
 *   w.probeOnce();        // 手动触发一次探测（返回 Promise<boolean>）
 *   w.stop();
 *
 * 可用环境变量覆盖探测目标：NET_PROBE_TARGETS="host:port,host:port"、
 * NET_PROBE_DOMAIN=example.com、NET_PROBE_INTERVAL_MS=5000、
 * NET_PROBE_TIMEOUT_MS=3000、NET_PROBE_FAIL_THRESHOLD=2。
 */
import net from "node:net";
import dns from "node:dns";
import { EventEmitter } from "node:events";

// 默认探测目标：国内外常见可达地址（DNS/HTTPS 端口），任一连通即在线。
// 中国网络环境下 8.8.8.8 常被墙，故以 223.5.5.5(阿里) / 114.114.114.114 打头。
const DEFAULT_TARGETS = [
  { host: "223.5.5.5", port: 53 },
  { host: "114.114.114.114", port: 53 },
  { host: "1.1.1.1", port: 443 },
];
const DEFAULT_DOMAIN = "www.baidu.com";

function parseTargets(str) {
  if (!str) return null;
  const out = [];
  for (const part of String(str).split(",")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.lastIndexOf(":");
    if (i > 0) {
      const host = s.slice(0, i).trim();
      const port = Number(s.slice(i + 1));
      if (host && Number.isInteger(port) && port > 0) out.push({ host, port });
    } else {
      out.push({ host: s, port: 443 });
    }
  }
  return out.length ? out : null;
}

/** 单个 TCP 连接探测：timeout 内 connect 成功即 true */
function tryConnect({ host, port }, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* noop */
      }
      resolve(ok);
    };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** 单个域名解析探测：解析成功即 true（出网 DNS 可达 = 有网） */
function tryDns(domain, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    dns.lookup(domain, (err) => {
      clearTimeout(t);
      done(!err);
    });
  });
}

/**
 * 创建网络探测器。
 * @param {object} opts
 * @param {() => void} [opts.onOnline]  离线→在线 触发
 * @param {() => void} [opts.onOffline] 在线→离线 触发
 * @param {(online:boolean, info:object) => void} [opts.onChange] 任意状态变化
 * @param {number} [opts.intervalMs] 轮询间隔
 * @param {number} [opts.timeoutMs] 单目标超时
 * @param {number} [opts.failThreshold] 连续失败多少次判离线
 */
export function createNetworkWatcher(opts = {}) {
  const targets =
    parseTargets(process.env.NET_PROBE_TARGETS) ||
    opts.targets ||
    DEFAULT_TARGETS;
  const domain = process.env.NET_PROBE_DOMAIN || opts.domain || DEFAULT_DOMAIN;
  const intervalMs =
    opts.intervalMs ??
    (Number(process.env.NET_PROBE_INTERVAL_MS) || 5000);
  const timeoutMs =
    opts.timeoutMs ?? (Number(process.env.NET_PROBE_TIMEOUT_MS) || 3000);
  const failThreshold =
    opts.failThreshold ??
    (Number(process.env.NET_PROBE_FAIL_THRESHOLD) || 2);

  const emitter = new EventEmitter();
  let online = true; // 乐观初始：首帧探测后再校正
  let consecutiveFails = 0;
  let probing = false;
  let timer = null;
  let started = false;

  const info = () => ({
    online,
    checked_at: new Date().toISOString(),
    targets: targets.map((t) => `${t.host}:${t.port}`),
    domain,
    consecutive_fails: consecutiveFails,
  });

  /** 执行一轮探测，返回是否在线；按阈值更新状态并触发回调 */
  async function probeOnce() {
    if (probing) return online;
    probing = true;
    try {
      const reachable = await anyReachable();
      if (reachable) {
        consecutiveFails = 0;
        if (!online) transition(true);
      } else {
        consecutiveFails++;
        if (online && consecutiveFails >= failThreshold) transition(false);
      }
    } finally {
      probing = false;
    }
    return online;
  }

  /**
   * 任一目标连通即视为在线并立刻短路返回（在线时毫秒级返回，不等最慢目标）；
   * 全部失败才耗满超时（离线判定）。避免单个恒超时目标把每轮探测拖满 timeout。
   */
  function anyReachable() {
    const probes = [
      ...targets.map((t) => tryConnect(t, timeoutMs)),
      tryDns(domain, timeoutMs),
    ];
    return new Promise((resolve) => {
      let settled = false;
      let remaining = probes.length;
      const finish = (ok) => {
        if (settled) return;
        if (ok) {
          settled = true;
          resolve(true);
        } else if (--remaining === 0) {
          settled = true;
          resolve(false);
        }
      };
      probes.forEach((p) => p.then(finish, () => finish(false)));
    });
  }

  /** 状态翻转：更新内存、发射事件 */
  function transition(next) {
    online = next;
    const snap = info();
    if (next) {
      emitter.emit("online", snap);
    } else {
      emitter.emit("offline", snap);
    }
    emitter.emit("change", next, snap);
  }

  function start() {
    if (started) return;
    started = true;
    probeOnce().catch(() => {});
    timer = setInterval(() => probeOnce().catch(() => {}), intervalMs);
    timer.unref?.();
  }

  function stop() {
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    probeOnce,
    isOnline: () => online,
    getInfo: info,
    on: (ev, fn) => {
      emitter.on(ev, fn);
      return () => emitter.off(ev, fn);
    },
  };
}
