"use strict";
/* 远程查看(GitHub Pages 等静态网页)用:
   1. 显示密码框;用 WebCrypto 从密码推导密钥(PBKDF2-SHA256),解密 data.bin(AES-256-GCM),再 gunzip 得到数据;
   2. 用 JS 实现和桌面版 Python 一样的 get_view(时间范围、断档虚线、抽稀、K 线、均线、卡片),
      装成 window.pywebview.api,app.js 不用改就能直接显示;
   3. 每分钟重新下载一次 data.bin,有新数据就刷新图表。
   密码不会被保存;勾选"记住"时只在本机浏览器里保存推导出的密钥。 */
(function () {
  const KEY_STORE = "remote.key";       // {salt, key}:记住此设备时保存的密钥(base64)
  const MAGIC = "OILREC1\n";
  const LINE_POINTS = 3000;
  const RANGES = { "1h": 1, "6h": 6, "24h": 24, "3d": 72, "7d": 168, "30d": 720, "90d": 2160, "1y": 8760, "all": 0 };
  const PERIODS = [["5 分", 5], ["15 分", 15], ["30 分", 30], ["1 时", 60], ["4 时", 240], ["日", "D"], ["周", "W"], ["月", "M"]];
  const PMIN = { D: 1440, W: 10080, M: 43200 };
  const MA_MAX = 4;

  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY_STORE)); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(KEY_STORE, JSON.stringify(v)); } catch (e) { /* 忽略 */ } },
    clear() { try { localStorage.removeItem(KEY_STORE); } catch (e) { /* 忽略 */ } },
  };

  // ---------- 下载 + 解密 ----------
  async function download(path) {
    // data.bin 每次带时间戳、不用缓存;bg.bin 网址里带版本号,可以放心缓存
    const r = path ? await fetch(path) : await fetch("data.bin?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("下载数据失败(" + r.status + ")");
    const buf = new Uint8Array(await r.arrayBuffer());
    const magic = new TextDecoder().decode(buf.slice(0, 8));
    if (magic !== MAGIC) throw new Error("数据文件格式不对");
    const salt = buf.slice(8, 24);
    const iters = new DataView(buf.buffer, buf.byteOffset + 24, 4).getUint32(0);
    return { salt, iters, nonce: buf.slice(28, 40), body: buf.slice(40) };
  }

  async function deriveKey(password, salt, iters) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iters }, base, 256);
  }

  async function decryptRaw(blob, rawKey) {
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.nonce }, key, blob.body);   // 密码错会抛错
  }

  async function openBlob(blob, rawKey) {
    const plain = await decryptRaw(blob, rawKey);
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }

  // ---------- 背景:bg.bin 用同一个密钥加密的 JPEG ----------
  let bgVersion = null, bgUrl = null;
  async function applyBackground(p) {
    const bg = p.bg;
    const root = document.documentElement.style;
    if (!bg) {
      document.body.classList.remove("has-bg");
      bgVersion = null;
      return;
    }
    root.setProperty("--bg-blur", `${bg.blur}px`);
    root.setProperty("--bg-dim", String(bg.dim));
    const credit = document.getElementById("bg-credit");
    if (credit) credit.textContent = `壁纸:${bg.title}${bg.artist ? " · 画师 " + bg.artist : ""} · ${bg.source}`;
    if (bg.v === bgVersion) return;
    try {
      const buf = await decryptRaw(await download("bg.bin?v=" + bg.v), KEY);
      const url = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
      const layer = document.getElementById("bg");
      layer.style.backgroundImage = `url("${url}")`;
      layer.classList.add("show");
      document.body.classList.add("has-bg");
      if (bgUrl) URL.revokeObjectURL(bgUrl);
      bgUrl = url;
      bgVersion = bg.v;
    } catch (e) {
      console.warn("背景加载失败", e);
    }
  }

  // ---------- 数据整理(和 Python 版 web_app.get_view 一一对应)----------
  function series(s, scale) {     // {t: 相差秒数[], v: []} -> {ts: 毫秒[], vs: []}
    const ts = new Array(s.t.length);
    let acc = 0;
    for (let i = 0; i < s.t.length; i++) { acc += s.t[i]; ts[i] = acc * 1000; }
    return { ts, vs: s.v };
  }
  function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
  function upperBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
  function filter(s, lo, hi) {
    const i = lo ? lowerBound(s.ts, lo) : 0, j = hi ? upperBound(s.ts, hi) : s.ts.length;
    return { ts: s.ts.slice(i, j), vs: s.vs.slice(i, j) };
  }
  function windowOf(data, hours, now, start, end) {
    const all = [];
    for (const k in data) if (data[k].ts.length) all.push(data[k].ts[0], data[k].ts[data[k].ts.length - 1]);
    if (start || end) {
      const lo = start || (all.length ? Math.min(...all) : now - 3600e3);
      const hi = end || now;
      return [lo, Math.max(hi, lo + 60e3)];
    }
    if (hours) return [now - hours * 3600e3, now];
    if (!all.length) return [now - 3600e3, now];
    const lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.02 || 5 * 60e3;
    return [lo - pad, hi + pad];
  }
  function splitOnGaps(ts, vs, gapMin) {
    const segs = [];
    let cur = { ts: [], vs: [] };
    for (let i = 0; i < ts.length; i++) {
      if (i && ts[i] - ts[i - 1] > gapMin * 60e3) { segs.push(cur); cur = { ts: [], vs: [] }; }
      cur.ts.push(ts[i]); cur.vs.push(vs[i]);
    }
    if (cur.ts.length) segs.push(cur);
    return segs;
  }
  function decimate(ts, vs, budget) {
    const n = ts.length;
    if (n <= budget) return { ts, vs };
    const k = Math.ceil(n / Math.max(Math.floor(budget / 4), 1));
    const outT = [], outV = [];
    for (let s = 0; s < n; s += k) {
      const e = Math.min(s + k, n);
      let lo = s, hi = s;
      for (let i = s; i < e; i++) { if (vs[i] < vs[lo]) lo = i; if (vs[i] > vs[hi]) hi = i; }
      for (const i of [...new Set([s, lo, hi, e - 1])].sort((a, b) => a - b)) { outT.push(ts[i]); outV.push(vs[i]); }
    }
    return { ts: outT, vs: outV };
  }
  function lineOf(ts, vs, gapMin) {
    const segs = splitOnGaps(ts, vs, gapMin);
    const total = Math.max(ts.length, 1);
    const line = [], gaps = [], dots = [];
    segs.forEach((sg, i) => {
      if (i) {
        const p = segs[i - 1];
        gaps.push([p.ts[p.ts.length - 1], p.vs[p.vs.length - 1]], [sg.ts[0], sg.vs[0]], [sg.ts[0], "-"]);
      }
      if (sg.ts.length === 1) { dots.push([sg.ts[0], sg.vs[0]]); return; }
      const d = decimate(sg.ts, sg.vs, Math.max(8, Math.floor(LINE_POINTS * sg.ts.length / total)));
      for (let j = 0; j < d.ts.length; j++) line.push([d.ts[j], d.vs[j]]);
      line.push([d.ts[d.ts.length - 1], "-"]);
    });
    return { line, gaps, dots };
  }
  const pmin = (p) => PMIN[p] || p;
  // K 线分格按北京时间(和桌面版一样;手机在别的时区也按北京时间的整点、0 点切)
  const BJ = 8 * 3600e3;
  function bucketStart(t, p) {
    const d = new Date(t + BJ);           // 用 UTC 读出来就是北京时间
    let s;
    if (p === "M") s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    else if (p === "D" || p === "W") {
      s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      if (p === "W") s -= ((d.getUTCDay() + 6) % 7) * 864e5;            // 周一开始
    } else if (p >= 60) {
      const h = p / 60;
      s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() - d.getUTCHours() % h);
    } else {
      s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes() - d.getUTCMinutes() % p);
    }
    return s - BJ;
  }
  function bucketEnd(s, p) {
    const d = new Date(s + BJ);
    if (p === "M") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - BJ;
    if (p === "D") return s + 864e5;
    if (p === "W") return s + 7 * 864e5;
    return s + p * 60e3;
  }
  function choosePeriod(name, w) {
    const span = Math.max((w[1] - w[0]) / 60e3, 1);
    const last = PERIODS[PERIODS.length - 1];
    if (name === "自动") {
      for (const [n, p] of PERIODS) if (span / pmin(p) <= 200) return [n, p, ""];
      return [last[0], last[1], ""];
    }
    let idx = PERIODS.findIndex((x) => x[0] === name);
    if (idx < 0) idx = 3;
    for (const [n, p] of PERIODS.slice(idx)) {
      if (span / pmin(p) <= 2000) return [n, p, n === name ? "" : `${name} 线在这个范围里太密,已改用 ${n}`];
    }
    return [last[0], last[1], ""];
  }
  function makeCandles(ts, vs, p) {
    const out = [];
    let cur = null, key = null;
    for (let i = 0; i < ts.length; i++) {
      const k = bucketStart(ts[i], p), v = vs[i];
      if (k !== key) {
        if (cur) out.push(cur);
        key = k;
        cur = { start: k, end: bucketEnd(k, p), open: v, high: v, low: v, close: v, count: 1 };
      } else {
        cur.high = Math.max(cur.high, v); cur.low = Math.min(cur.low, v); cur.close = v; cur.count++;
      }
    }
    if (cur) out.push(cur);
    return out;
  }
  function movingAverage(cs, n) {
    const out = [], win = [];
    let total = 0;
    for (const c of cs) {
      win.push(c.close); total += c.close;
      if (win.length > n) total -= win.shift();
      out.push(win.length === n ? total / n : null);
    }
    return out;
  }

  // ---------- 装成 pywebview.api ----------
  let DATA = null, KEY = null, lastGenerated = 0, events = [], seq = 0, lastFetch = 0, fetching = false;

  function prepare(p) {
    return {
      raw: p,
      oil: series(p.oil), coin: series(p.coin), exp: series(p.exp),
      cube: series(p.cube || { t: [], v: [] }),
      medal: series(p.medal || { t: [], v: [] }),
      generated: p.generated * 1000,
    };
  }
  function pushEvent(text, level, refresh) { events.push({ seq: ++seq, t: Date.now(), text, level, refresh }); if (events.length > 200) events.shift(); }

  async function refetch() {
    if (fetching || !KEY) return;
    fetching = true;
    lastFetch = Date.now();
    try {
      const blob = await download();
      const p = await openBlob(blob, KEY);
      if (p.generated * 1000 !== lastGenerated) {
        const first = !DATA;
        DATA = prepare(p);
        lastGenerated = DATA.generated;
        applyBackground(p);                // 背景换了才会重新下载
        if (!first) pushEvent(`收到新数据(电脑于 ${fmtHM(DATA.generated)} 上传)`, "ok", true);
      }
    } catch (e) {
      pushEvent("更新数据失败:" + (e.message || e), "warn", false);
    } finally {
      fetching = false;
    }
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtHM = (ms) => { const d = new Date(ms); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

  const api = {
    async ui_config() { return { theme: null }; },
    async template_info() { return { bar: "", profile: "" }; },
    async sortie_stats(n, mode) {        // 电脑上传时算好的最近 7 天出击统计和时间线 / 最近 8 周的周报
      const days = (DATA.raw.status || {})[mode === "week" ? "sortie_weeks" : "sortie_stats"];
      return days ? { ok: true, days } : { ok: false, message: "电脑上的面板还没有上传出击统计(更新面板后,下次上传就有)" };
    },
    async poll(after) {
      if (Date.now() - lastFetch > 60e3) refetch();      // 每分钟看一次有没有新数据
      const st = DATA.raw.status || {};
      return {
        status: { remote_view: true, generated: DATA.generated, sampling: !!st.sampling, alas: st.alas || null,
                  alas_card: st.alas_card || null, work: st.work || null, fleet: st.fleet || null, last: st.last || null,
                  server: st.server || null,      // 上传时游戏服务器是否在维护(顶栏“游戏维护中”)
                  user_tz: st.user_tz || null,    // 设置里的“我的时区”(补“你那里 …”的时间用)
                  interval: st.interval || 60, counts: {} },
        events: events.filter((e) => e.seq > (after || 0)),
      };
    },
    async get_view(opts) {
      opts = opts || {};
      const now = Date.now();
      const start = opts.start || null, end = opts.end || null;
      const hours = (start || end) ? 0 : (RANGES[opts.range] ?? 0);
      const mode = opts.mode || "line";
      const ma = (opts.ma || []).map(Number).filter((n) => n >= 2).slice(0, MA_MAX);
      const [gap, expGap] = DATA.raw.gap || [10, 360];
      const lo = start || (hours ? now - hours * 3600e3 : null), hi = end || null;
      const data = { coin: filter(DATA.coin, lo, hi), oil: filter(DATA.oil, lo, hi), exp: filter(DATA.exp, lo, hi) };
      // 第三栏选了“魔方”:魔方数量历史(和桌面版一样放在 out.cube,断档阈值和等级进度相同)
      const cube = opts.third === "cube" ? filter(DATA.cube, lo, hi) : null;
      const win = windowOf(cube ? { ...data, cube } : data, hours, now, start, end);
      const out = { window: win, mode, series: {}, now };
      if (cube) {
        const { ts, vs } = cube;
        const s = { count: vs.length };
        if (vs.length) {
          Object.assign(s, { first: vs[0], last: vs[vs.length - 1], last_time: ts[ts.length - 1],
                             min: Math.min(...vs), max: Math.max(...vs) });
        }
        Object.assign(s, lineOf(ts, vs, expGap));
        out.cube = s;
      }
      let pval = null;
      if (mode === "candle") {
        const [pname, pv, pnote] = choosePeriod(opts.period || "自动", win);
        pval = pv;
        Object.assign(out, { period: pname, period_note: pnote });
      }
      for (const key of ["coin", "oil", "exp"]) {
        const { ts, vs } = data[key];
        const s = { count: vs.length };
        if (vs.length) {
          let mn = Infinity, mx = -Infinity;
          for (const v of vs) { if (v < mn) mn = v; if (v > mx) mx = v; }
          Object.assign(s, { first: vs[0], last: vs[vs.length - 1], last_time: ts[ts.length - 1], min: mn, max: mx });
        }
        if (mode === "candle" && key !== "exp" && vs.length) {
          const cs = makeCandles(ts, vs, pval);
          const centers = cs.map((c) => c.start + Math.floor((c.end - c.start) / 2));
          s.candles = cs.map((c, i) => [centers[i], c.open, c.close, c.low, c.high, c.count]);
          s.ma = {};
          for (const n of ma) {
            const vals = movingAverage(cs, n);
            s.ma[String(n)] = vals.map((v, i) => [centers[i], v === null ? null : Math.round(v * 10) / 10]).filter((p) => p[1] !== null);
          }
        } else {
          Object.assign(s, lineOf(ts, vs, key === "exp" ? expGap : gap));
        }
        out.series[key] = s;
      }
      const tiles = {};
      for (const key of ["coin", "oil"]) {
        const all = DATA[key], { vs } = data[key];
        tiles[key] = { value: all.vs.length ? all.vs[all.vs.length - 1] : null,
                       time: all.ts.length ? all.ts[all.ts.length - 1] : null,
                       change: vs.length >= 2 ? vs[vs.length - 1] - vs[0] : null,
                       pred: ((DATA.raw.status || {}).forecast || {})[key] || null };   // 上传时算好的预测
      }
      {   // 魔方
        const all = DATA.cube, { vs } = filter(DATA.cube, lo, hi);
        tiles.cube = { value: all.vs.length ? all.vs[all.vs.length - 1] : null,
                       time: all.ts.length ? all.ts[all.ts.length - 1] : null,
                       change: vs.length >= 2 ? vs[vs.length - 1] - vs[0] : null };
      }
      {   // 勋章(显示在魔方卡片里)
        const all = DATA.medal, { vs } = filter(DATA.medal, lo, hi);
        tiles.medal = { value: all.vs.length ? all.vs[all.vs.length - 1] : null,
                        time: all.ts.length ? all.ts[all.ts.length - 1] : null,
                        change: vs.length >= 2 ? vs[vs.length - 1] - vs[0] : null };
      }
      const e = DATA.raw.exp_last ? { ...DATA.raw.exp_last } : null;
      if (e) {
        e.time *= 1000;
        e.pct = Math.round(e.exp / Math.max(e.exp_max, 1) * 1000) / 10;
        const vs = data.exp.vs;
        e.change = vs.length >= 2 ? Math.round((vs[vs.length - 1] - vs[0]) * 1000) / 10 : null;
      }
      tiles.exp = e;
      out.tiles = tiles;
      return out;
    },
    async log(msg) { console.warn("[页面]", msg); },
  };

  // ---------- 密码界面 ----------
  function lockScreen(message) {
    let el = document.getElementById("lock");
    if (!el) {
      el = document.createElement("div");
      el.id = "lock";
      el.innerHTML = `
        <div class="lock-card">
          <svg class="lock-icon" viewBox="0 0 24 24"><defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#5ac8fa"/><stop offset="1" stop-color="#007aff"/></linearGradient></defs>
            <rect x="1" y="1" width="22" height="22" rx="6" fill="url(#lg)"/>
            <path d="M12 5.2c2.6 3.3 4.2 5.6 4.2 7.6a4.2 4.2 0 0 1-8.4 0c0-2 1.6-4.3 4.2-7.6z" fill="#fff"/></svg>
          <h1>碧蓝航线面板</h1>
          <p class="lock-sub">输入密码查看</p>
          <form id="lock-form" autocomplete="off">
            <input id="lock-pw" type="password" placeholder="密码" autocomplete="current-password" required>
            <label class="lock-remember"><span>在这台设备上记住</span><input type="checkbox" class="switch" id="lock-remember" checked></label>
            <button class="btn primary" id="lock-go" type="submit">解锁</button>
          </form>
          <p class="lock-msg" id="lock-msg"></p>
        </div>`;
      document.body.appendChild(el);
      document.getElementById("lock-form").addEventListener("submit", (ev) => { ev.preventDefault(); unlock(); });
    }
    document.getElementById("lock-msg").textContent = message || "";
    el.classList.add("show");
    setTimeout(() => document.getElementById("lock-pw").focus(), 50);
  }

  async function unlock() {
    const pw = document.getElementById("lock-pw").value;
    const btn = document.getElementById("lock-go");
    btn.disabled = true;
    btn.textContent = "解锁中…";
    try {
      const blob = await download();
      const raw = await deriveKey(pw, blob.salt, blob.iters);
      let p;
      try { p = await openBlob(blob, raw); } catch (e) { throw new Error("密码不对"); }
      KEY = raw;
      if (document.getElementById("lock-remember").checked) store.set({ salt: b64(blob.salt), key: b64(raw) });
      start(p);
    } catch (e) {
      document.getElementById("lock-msg").textContent = e.message || String(e);
      const card = document.querySelector(".lock-card");
      card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
    } finally {
      btn.disabled = false;
      btn.textContent = "解锁";
    }
  }

  function start(p) {
    DATA = prepare(p);
    lastGenerated = DATA.generated;
    lastFetch = Date.now();
    const lock = document.getElementById("lock");
    if (lock) lock.classList.remove("show");
    addNavButtons();
    window.pywebview = { api };
    window.dispatchEvent(new Event("pywebviewready"));
    applyBackground(p);
    if (p.logo && typeof showLogo === "function") showLogo(p.logo);   // 程序图标在加密数据里,解锁后才显示
    if (p.icons && typeof showTileIcons === "function") showTileIcons(p.icons);   // 资源图标也一样
  }

  function addNavButtons() {
    const right = document.querySelector(".nav-right");
    if (!right || document.getElementById("btn-lock")) return;
    const st = document.createElement("button");      // 出击统计和任务时间线(和电脑上 ··· 菜单里的一样)
    st.className = "btn secondary";
    st.id = "btn-stats";
    st.textContent = "统计";
    st.title = "出击统计和 Alas 任务时间线";
    st.addEventListener("click", () => { if (typeof openStats === "function") openStats(); });
    right.appendChild(st);
    const b = document.createElement("button");
    b.className = "btn secondary";
    b.id = "btn-lock";
    b.textContent = "锁定";
    b.title = "忘记这台设备上记住的密钥,下次打开要重新输入密码";
    b.addEventListener("click", () => { store.clear(); location.reload(); });
    right.appendChild(b);
  }

  async function boot() {
    // 浏览器只在 https 页面里提供解密功能。用了自定义域名时 GitHub Pages 可能跳到 http 地址,这里自动换成 https
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (location.protocol === "http:" && !local) {
      location.replace("https://" + location.host + location.pathname + location.search + location.hash);
      return;
    }
    if (!window.isSecureContext) {
      lockScreen("请用 https:// 开头的地址打开这个网页(浏览器只在 https 页面里提供解密功能)。");
      return;
    }
    if (!window.crypto || !crypto.subtle || !window.DecompressionStream) {
      lockScreen("这个浏览器太旧,不支持解密。请用新版的 Safari / Chrome / Edge 打开。");
      return;
    }
    const saved = store.get();
    if (saved) {
      try {
        const blob = await download();
        if (b64(blob.salt) === saved.salt) {        // 密码没换过:直接用记住的密钥
          KEY = unb64(saved.key).buffer;
          start(await openBlob(blob, KEY));
          return;
        }
      } catch (e) { /* 记住的密钥失效(换了密码等):回到密码框 */ }
      store.clear();
    }
    lockScreen("");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
