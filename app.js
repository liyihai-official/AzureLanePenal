"use strict";
/* 碧蓝航线面板(AzurLanePanel)界面 · 第 3 步:展示 + 采样 + 设置、补模板、导入历史、立即记录经验、导出图片
   数据来自 Python:window.pywebview.api.get_view(opts);采样状态和日志每秒 api.poll(seq) 取一次。 */

const $ = (s) => document.querySelector(s);
const KEYS = ["coin", "oil", "exp"];
const NAMES = { coin: "物资", oil: "石油", exp: "等级进度", cube: "魔方" };
const RATIO = { coin: 3, oil: 2, exp: 1.4 };
const RANGE_NAMES = { "1h": "1 小时", "6h": "6 小时", "24h": "24 小时", "3d": "3 天", "7d": "7 天",
                      "30d": "30 天", "90d": "90 天", "1y": "1 年", "all": "全部" };
const REFRESH_MS = 30000;
const TOUCH = window.matchMedia && matchMedia("(pointer: coarse)").matches;

// 记住页面上的选择(只是方便,读不到就用默认值)
const store = {
  get(k, d) { try { const v = localStorage.getItem("ui." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("ui." + k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } },
};
const state = {
  range: store.get("range", "24h"), mode: store.get("mode", "line"),
  period: store.get("period", "自动"), ma: store.get("ma", "5,10,20"),
  zoom: null, view: null, first: true, lastInteract: 0,
  // 第三栏:exp = 等级进度,eff = 经验 vs 油耗(散点),cube = 魔方数量;散点每个点代表多少小时
  third: store.get("third", "exp"), effHours: +store.get("effHours", 24),
};
// 远程网页没有散点的数据:第三栏只有“等级进度 | 魔方”
const isRemote = () => document.body.classList.contains("remote");
const thirdMode = () => (isRemote() && state.third === "eff" ? "exp" : state.third);
// 第三栏画什么:等级进度;选了“魔方”时画魔方数量(数据在 v.cube,不在 v.series 里)
const thirdKey = (v) => (thirdMode() === "cube" && v && v.cube ? "cube" : "exp");
const dataKey = (v, key) => (key === "exp" ? thirdKey(v) : key);
const seriesOf = (v, key) => (dataKey(v, key) === "cube" ? v.cube : v.series[key]);
function setThird(v) { state.third = v; store.set("third", v); load(false); }
function setEffHours(h) { state.effHours = h; store.set("effHours", h); load(false); }
let api = null, chart = null, busy = false, pending = false, ignoreZoom = false, zoomTimer = null;
let moveRange = null, moveMode = null;

// ---------- 小工具 ----------
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pad2 = (n) => String(n).padStart(2, "0");
// ---------- 时间:页面上统一按北京时间(游戏、Alas、官网公告都用北京时间)----------
// 不管看网页的设备在哪个时区都一样:时间戳加 8 小时后用 UTC 读出来(中国没有夏令时)。
// 需要的地方再用“你那里 …”补上本人所在时区的时间(设置里的“我的时区”,远程网页没填就用手机的时区)。
const GAME_OFFSET_MS = 8 * 3600e3;
const bj = (ms) => new Date(ms + GAME_OFFSET_MS);              // 读的时候用 getUTC*
const bjDay = (ms) => bj(ms).toISOString().slice(0, 10);
function fmtTime(ms, withYear) {
  const d = bj(ms);
  const date = `${withYear ? d.getUTCFullYear() + "-" : ""}${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
const hhmm = (ms) => { const d = bj(ms); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
const mmdd = (ms) => { const d = bj(ms); return `${d.getUTCMonth() + 1}-${d.getUTCDate()}`; };
// 本人所在时区:设置里填的优先,否则用这台设备的(桌面面板的电脑是北京时间,不填就不显示“你那里”)
const userTz = () => state.userTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
const tzFmt = {};
function tzParts(ms, tz) {
  try {
    tzFmt[tz] = tzFmt[tz] || new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric",
                                                                 month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const p = {};
    tzFmt[tz].formatToParts(ms).forEach((x) => { p[x.type] = x.value; });
    return p;
  } catch (e) { return null; }                                  // 时区名字不对
}
function localDiffers(ms) {
  const p = tzParts(ms, userTz());
  if (!p) return false;
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return Math.round((local - ms) / 60000) !== 480 && Math.abs(local - ms - GAME_OFFSET_MS) >= 60000;
}
// “你那里”的时间:和北京时间不是同一天时带上日期
function localHM(ms) {
  const p = tzParts(ms, userTz());
  if (!p) return "";
  const t = `${+p.hour % 24 < 10 ? "0" : ""}${+p.hour % 24}:${p.minute}`;
  return `${p.year}-${p.month}-${p.day}` === bjDay(ms) ? t : `${+p.month}-${+p.day} ${t}`;
}
const localNote = (ms) => (ms && localDiffers(ms) ? `(你那里 ${localHM(ms)})` : "");
function localSpan(a, b) {      // 跨过你那里的 0 点时,结束时间也带日期
  if (!a || !localDiffers(a)) return "";
  const pa = tzParts(a, userTz()), pb = tzParts(b, userTz());
  let sb = localHM(b);
  if (pa && pb && pa.day !== pb.day && !sb.includes(" ")) sb = `${+pb.month}-${+pb.day} ${sb}`;
  return `(你那里 ${localHM(a)}–${sb})`;
}
const num = (v) => Math.round(v).toLocaleString("en-US");
function fmtValue(key, v) {
  if (v === null || v === undefined) return "—";
  if (key === "exp") { const lv = Math.floor(v); return `LV.${lv} · ${((v - lv) * 100).toFixed(1)}%`; }
  return num(v);
}
function axisLabel(key) {
  if (key === "exp") return (v) => v.toFixed(2);
  return (v) => (Math.abs(v) >= 10000 ? `${+(v / 1000).toFixed(1)}K` : num(v));
}
function rgba(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function maList() {
  const out = [];
  String(state.ma).replace(/[,，\s]+/g, ",").split(",").forEach((p) => {
    const n = parseInt(p, 10);
    if (n >= 2 && n <= 500 && !out.includes(n)) out.push(n);
  });
  return out.sort((a, b) => a - b).slice(0, 4);
}
function report(e) {
  try { if (api) api.log(String((e && (e.stack || e.message)) || e)); } catch (x) { /* 忽略 */ }
}
window.addEventListener("error", (e) => report(`${e.message} @${e.lineno}:${e.colno}`));
window.addEventListener("unhandledrejection", (e) => report(e.reason));

// ---------- 分段选择器 ----------
function segmented(id, value, onPick) {
  const el = document.getElementById(id);
  const btns = [...el.querySelectorAll("button")];
  const thumb = el.querySelector(".thumb");
  function move(v, animate = true) {
    const b = btns.find((x) => x.dataset.v === v);
    el.classList.toggle("none", !b);
    btns.forEach((x) => x.classList.toggle("on", x === b));
    if (!b) return;
    if (!animate) thumb.style.transition = "none";
    thumb.style.width = b.offsetWidth + "px";
    thumb.style.transform = `translateX(${b.offsetLeft - 2}px)`;
    if (!animate) { void thumb.offsetWidth; thumb.style.transition = ""; }
  }
  btns.forEach((b) => b.addEventListener("click", () => { move(b.dataset.v); onPick(b.dataset.v); }));
  move(value, false);
  return move;
}

// ---------- 数字滚动动画 ----------
function countTo(el, to, format) {
  const from = el.dataset.v === undefined ? to * 0.92 : +el.dataset.v;
  el.dataset.v = to;
  if (from === to) { el.textContent = format(to); return; }
  const t0 = performance.now(), dur = 900;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = format(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- 卡片 ----------
// 资源预测(forecast.py 算好的):近 6 小时速度 + 几点到上限 / 几点降到 Alas 的停止出击线
function predWhen(ms) {          // 北京时间的“今天 / 明天 / 11-26”+ 你那里的时间
  const now = Date.now();
  const day = bjDay(ms) === bjDay(now) ? "" : (bjDay(ms) === bjDay(now + 864e5) ? "明天 " : `${mmdd(ms)} `);
  return day + hhmm(ms) + localNote(ms);
}
function renderPred(key, p) {
  const el = $(`#p-${key}`);
  if (!el) return;
  el.hidden = !p;
  if (!p) return;
  const rate = `近 ${p.window_h} 小时 ${p.rate > 0 ? "+" : p.rate < 0 ? "−" : "±"}${num(Math.abs(p.rate))}/时`;
  let msg = "";
  if (p.level === "full") msg = `已到上限 ${num(p.cap)},不再自然产出`;
  else if (p.level === "low") msg = `低于 ${num(p.limit)},Alas 停止出击`;
  else if (p.eta_limit) msg = `约 ${predWhen(p.eta_limit)} 降到 ${num(p.limit)}(Alas 停止出击)`;
  else if (p.eta_cap) msg = `约 ${predWhen(p.eta_cap)} 到上限 ${num(p.cap)}`;
  el.textContent = msg ? `${rate} · ${msg}` : rate;
  el.className = "tile-pred " + p.level;
  el.title = "按最近 6 小时的平均变化速度估计;出击、委托会让实际时间提前或推后";
}

// 魔方卡片里的“勋章”一行(建造-支援页,几小时记一次)
function renderMedal(t) {
  const line = $("#medal-line");
  if (!line) return;
  const val = $("#v-medal"), chip = $("#c-medal"), meta = $("#m-medal");
  if (!t || t.value === null || t.value === undefined) {
    val.textContent = "—"; chip.textContent = ""; meta.textContent = "尚无记录";
    return;
  }
  val.textContent = num(t.value);
  if (t.change === null || t.change === undefined) chip.textContent = "";
  else {
    chip.className = "chip " + (t.change > 0 ? "up" : t.change < 0 ? "down" : "flat");
    chip.textContent = (t.change > 0 ? "+" : t.change < 0 ? "−" : "±") + num(Math.abs(t.change));
  }
  meta.textContent = `${fmtTime(t.time)} 更新`;
}

function renderTiles(v) {
  const label = state.zoom ? "所选范围" : RANGE_NAMES[state.range];
  for (const key of ["coin", "oil", "cube"]) {
    const t = v.tiles[key];
    const valEl = $(`#v-${key}`), chip = $(`#c-${key}`), meta = $(`#m-${key}`);
    if (!valEl) continue;
    if (!t || t.value === null) {
      valEl.textContent = "—"; chip.textContent = "";
      meta.textContent = key === "cube" ? "尚无记录" : "尚无读数";
      continue;
    }
    countTo(valEl, t.value, num);
    if (t.change === null) { chip.textContent = ""; }
    else {
      chip.className = "chip " + (t.change > 0 ? "up" : t.change < 0 ? "down" : "flat");
      chip.textContent = (t.change > 0 ? "+" : t.change < 0 ? "−" : "±") + num(Math.abs(t.change));
    }
    chip.title = `${label}内的变化`;          // 标题行放不下“24 小时 ·”,写在提示里
    // 魔方几小时才记一次,写出日期
    meta.textContent = `${key === "cube" ? fmtTime(t.time) : hhmm(t.time)} 更新`;
  }
  for (const key of ["coin", "oil"]) renderPred(key, v.tiles[key] && v.tiles[key].pred);
  renderMedal(v.tiles.medal);
  const e = v.tiles.exp;
  if (e) {
    $("#v-exp").textContent = `LV.${e.level}`;
    $("#bar-exp").style.width = `${e.pct}%`;
    const ch = e.change === null ? "" : ` · ${label} ${e.change >= 0 ? "+" : "−"}${Math.abs(e.change).toFixed(1)}%`;
    const meta = $("#m-exp");                              // 在进度条上方靠右,长短不影响进度条
    meta.textContent = `${num(e.exp)} / ${num(e.exp_max)} · ${e.pct}%${ch}`;
    meta.title = meta.textContent;                         // 窄窗口放不下被省略时,悬停能看全
  } else {
    $("#v-exp").textContent = "—";
    $("#m-exp").textContent = "尚无经验记录";
  }
  state.lastReading = Math.max(v.tiles.coin?.time || 0, v.tiles.oil?.time || 0);
  renderHeroSub();
}

// 标题下的一行说明:最近一次读数 + Alas 当前状态
function renderHeroSub() {
  const parts = ["碧蓝航线"];
  parts.push(state.lastReading ? `最近一次读数 ${fmtTime(state.lastReading)}` : "还没有读数");
  // Alas 状态有专门的卡片;旧版上传的数据(没有卡片信息)才在这一行显示
  if (document.body.classList.contains("remote") && state.status && state.status.alas && !state.status.alas_card) parts.push(state.status.alas);
  $("#hero-sub").textContent = parts.join(" · ");
}

// ---------- 提示框 ----------
function modal(title, text, buttons) {
  return new Promise((resolve) => {
    $("#modal-title").textContent = title;
    $("#modal-text").textContent = text || "";
    const box = $("#modal-btns");
    box.innerHTML = "";
    buttons.forEach((b) => {
      const el = document.createElement("button");
      el.className = "btn " + (b.kind || "secondary");
      el.textContent = b.label;
      el.addEventListener("click", () => { $("#modal").classList.remove("show"); resolve(b.value); });
      box.appendChild(el);
    });
    $("#modal").classList.add("show");
    const last = box.lastElementChild;
    if (last) setTimeout(() => last.focus(), 50);
  });
}
const alertBox = (title, text) => modal(title, text, [{ label: "好", kind: "primary", value: true }]);
// 带密码输入框的对话框:确定返回输入的内容,取消返回 null
async function askPassword(title, text) {
  const input = $("#modal-input");
  input.value = "";
  input.hidden = false;
  setTimeout(() => input.focus(), 60);
  const onKey = (e) => { if (e.key === "Enter") $("#modal-btns").lastElementChild.click(); };
  input.addEventListener("keydown", onKey);
  const ok = await modal(title, text, [{ label: "取消", value: false }, { label: "确定", kind: "primary", value: true }]);
  input.removeEventListener("keydown", onKey);
  input.hidden = true;
  const v = input.value;
  input.value = "";
  return ok ? v : null;
}

// ---------- 采样控制 + 活动日志 ----------
// 顶栏“游戏维护中”(面板每 5 分钟查一次所在服务器;远程网页用上传时的状态)
// 维护中:“游戏维护中 · 预计 16:00 结束”(官网公告给的时间);48 小时内有公告的维护:“维护预告 11-26 10:00–16:00”
function noticeSpan(n) {         // 北京时间的维护时段,后面补你那里的时间
  const today = bjDay(Date.now()) === bjDay(n.start);
  const s = bj(n.start);
  return `${today ? "今天 " : `${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())} `}${hhmm(n.start)}–${hhmm(n.end)}` +
         (bjDay(n.end) !== bjDay(n.start) ? "(次日)" : "") + localSpan(n.start, n.end);
}
function renderServer(sv) {
  const pill = $("#maint-hint");
  if (!pill) return;
  const n = sv && sv.notice;
  const live = !!(sv && (sv.maintenance || (n && n.active)));
  const soon = !live && n && n.start - Date.now() < 48 * 3600e3;
  pill.hidden = !(live || soon);
  pill.classList.toggle("notice-pill", !!soon);
  if (live) {
    pill.textContent = "游戏维护中" + (n && n.end > Date.now() ? ` · 预计 ${hhmm(n.end)} 结束${localNote(n.end)}` : "");
    pill.title = [sv.text, n ? `官网公告:${n.title}${n.extended ? "(已延长)" : ""}` : "",
                  sv.checked ? `${hhmm(sv.checked)} 查询服务器状态` : ""].filter(Boolean).join("\n");
  } else if (soon) {
    pill.textContent = `维护预告 ${noticeSpan(n)}`;
    pill.title = `官网公告:${n.title}${n.extended ? "(已延长)" : ""}\n维护时段内不推送 Alas 出错、卡住、断开`;
  }
}
function renderStatus(s) {
  state.status = s;
  state.userTz = s.user_tz || null;     // 设置里的“我的时区”;没填就用这台设备的时区
  renderServer(s.server);
  if (s.remote_view) {     // 远程查看(手机网页):只显示数据是什么时候上传的、电脑是否在采样
    const fresh = Date.now() - s.generated < 20 * 60e3;
    $("#status").classList.toggle("live", s.sampling && fresh);
    if (s.user_tz) state.userTz = s.user_tz;            // 设置里填了“我的时区”就用它,否则用手机的时区
    $("#status-text").textContent = `数据 ${fmtTime(s.generated)} 北京时间` + (s.sampling ? (fresh ? " · 采样中" : " · 电脑可能已离线") : " · 电脑未在采样");
    if (s.alas_card && state.alasGen !== s.generated) {   // Alas 卡片(数据换了才重画)
      state.alasGen = s.generated;
      state.alas = s.alas_card;
      state.alasSkew = 0;
      renderAlas();
      state.work = s.work || null;
      renderWork();
      state.fleet = s.fleet || null;
      renderFleet();
    }
    renderHeroSub();
    return;
  }
  const pill = $("#status"), btn = $("#btn-start");
  pill.classList.toggle("live", s.running && !s.stopping);
  let text = "未运行";
  if (s.stopping) text = "正在停止…";
  else if (s.running) text = `采样中 · 每 ${+s.interval} 秒` + (s.last ? ` · ${s.last.time} ${s.last.status}` : "");
  if (s.busy) text = (s.running ? "采样中 · " : "") + s.busy + "…";
  $("#status-text").textContent = text;
  btn.classList.toggle("stop", s.running);
  btn.querySelector(".ico").textContent = s.running ? "■" : "▶";
  btn.querySelector(".label").textContent = s.running ? (s.stopping ? "正在停止…" : "停止采样") : "开始采样";
  btn.disabled = !!s.stopping || (!s.running && !!s.busy);
  if (state.busyWas && !s.busy) refreshTemplateHint();   // 忙完(比如导入)后顺便刷新
  state.busyWas = s.busy;
  // 自动上传失败时在顶栏提示(失败只记在日志里很容易看不到)
  const rm = s.remote || {};
  $("#remote-hint").hidden = !(rm.enabled && rm.last && !rm.last.ok);
  $("#btn-test").disabled = !!s.testing;
  $("#btn-test").textContent = s.testing ? "测试中…" : "测试连接";
  const counts = Object.entries(s.counts || {}).map(([k, n]) => `${k} ${n}`).join(" · ");
  $("#log-sub").textContent = counts ? `本次 ${counts}` : (s.exp_auto ? "自动记录经验:开" : "");
  renderHeroSub();
}

function addEntries(events) {
  const log = $("#log");
  if (!events.length) return;
  const empty = log.querySelector(".log-empty");
  if (empty) empty.remove();
  // 最新的在最上面:新消息插到顶部。用户往下翻看旧消息时不打扰,停在顶部时保持看到最新的
  const atTop = log.scrollTop < 40;
  const keep = log.scrollHeight - log.scrollTop;
  for (const e of events) {
    const el = document.createElement("div");
    el.className = "entry " + e.level;
    const lv = document.createElement("i");
    lv.className = "lv";
    const body = document.createElement("div");
    const time = document.createElement("div");
    time.className = "time";
    const d = bj(e.t);           // 北京时间
    time.textContent = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
    const msg = document.createElement("div");
    msg.className = "msg";
    msg.textContent = e.text;
    body.append(time, msg);
    el.append(lv, body);
    log.prepend(el);
  }
  while (log.children.length > 300) log.lastElementChild.remove();
  if (atTop) log.scrollTop = 0;
  else log.scrollTop = log.scrollHeight - keep;     // 正在看旧消息:位置不跳
}

async function pollService() {
  try {
    const r = await api.poll(state.seq || 0);
    renderStatus(r.status);
    if (r.events.length) {
      state.seq = r.events[r.events.length - 1].seq;
      addEntries(r.events);
      if (r.events.some((e) => e.refresh) && Date.now() - state.lastInteract > 5000) load(true);
      const alert = r.events.find((e) => e.alert);
      if (alert) alertBox("请看一眼游戏", alert.alert);
    }
  } catch (e) {
    report(e);
  }
}

async function onStart() {
  const btn = $("#btn-start");
  btn.disabled = true;
  try {
    if (state.status && state.status.running) { await api.stop(); return; }
    let r = await api.start(false);
    if (!r.ok && r.confirm) {
      const go = await modal("另一个程序可能还在采样", r.message, [
        { label: "取消", value: false }, { label: "仍然开始", kind: "primary", value: true }]);
      if (!go) return;
      r = await api.start(true);
    }
    if (!r.ok) await alertBox("无法开始采样", r.message);
  } catch (e) {
    report(e);
  } finally {
    btn.disabled = false;
    pollService();
  }
}

async function onTest() {
  const r = await api.test();
  if (!r.ok) await alertBox("无法测试连接", r.message);
  pollService();
}

// ---------- 面板(设置、补模板)和更多菜单 ----------
function openSheet(id) {
  closeMenu();
  const el = document.getElementById(id);
  el.classList.add("show");
  el.setAttribute("aria-hidden", "false");
}
function closeSheet(id) {
  const el = document.getElementById(id);
  el.classList.remove("show");
  el.setAttribute("aria-hidden", "true");
}
function closeMenu() { $("#menu").classList.remove("show"); $("#btn-more").classList.remove("on"); }

async function refreshTemplateHint() {
  try {
    const t = await api.template_info();
    const parts = [];
    if (t.bar) parts.push(`资源栏缺 ${t.bar}`);
    if (t.profile) parts.push(`个人信息页缺 ${t.profile}`);
    const pill = $("#tmpl-hint");
    pill.hidden = !parts.length;
    pill.textContent = parts.length ? "缺少数字模板 · " + parts.join(" · ") : "";
    // 魔方数字是遇到一个补一个(没认出来时日志会提示),缺几个是常态,只在补模板窗口里列出来,不占顶栏
    $("#t-missing").textContent = parts.concat(t.cube ? [`魔方缺 ${t.cube}`] : []).join(" · ");
  } catch (e) { report(e); }
}

// ----- 设置 -----
const NUM_KEYS = ["interval", "confirm", "max_jump", "rate", "coin_max_jump", "coin_rate", "exp_interval_h", "fleet_interval_h",
                  "res_coin_cap", "res_oil_cap"];
const BOOL_KEYS = ["log_no_bar", "read_alas_log", "exp_auto", "remote_enabled", "alas_flash",
                   "notify_alas_error", "notify_alas_stalled", "notify_adb", "notify_coin_full", "report_enabled",
                   "notify_maintenance", "notify_exp_off", "backup_enabled"];
const NOTIFY_TEXT = ["notify_mail_from", "notify_mail_to", "notify_mail_smtp", "report_time", "game_server", "user_tz"];
const LIVE_IDS = ["s-exp_auto", "s-remote_repo", "s-remote_branch", "s-remote_token", "s-remote_password", "s-remote_enabled",
                  "s-alas_flash", "n-sckey", "n-mail_pass", "s-notify_alas_error", "s-notify_alas_stalled", "s-notify_adb",
                  "s-notify_coin_full", "s-res_coin_cap", "s-res_oil_cap", "s-report_enabled", "s-fleet_surface", "s-fleet_sub",
                  "s-notify_maintenance", "s-notify_exp_off", "s-backup_enabled", ...NOTIFY_TEXT.map((k) => "s-" + k)];
const notifyClear = { sckey: false, mail_pass: false };

// 手机推送:SendKey、授权码只显示“已保存”,不把内容传给页面
function showNotifySecrets(s) {
  notifyClear.sckey = notifyClear.mail_pass = false;
  for (const [k, has, empty] of [["sckey", s.has_sckey, "SCT… 或 sctp…"], ["mail_pass", s.has_mail_pass, "邮箱的 SMTP 授权码"]]) {
    const input = $(`#n-${k}`);
    input.value = "";
    input.placeholder = has ? "已保存(留空不改)" : empty;
    $(`#n-${k}-clear`).hidden = !has;
  }
}
function clearNotifySecret(k) {
  notifyClear[k] = true;
  $(`#n-${k}`).value = "";
  $(`#n-${k}`).placeholder = "保存后清除";
  $(`#n-${k}-clear`).hidden = true;
}
async function testNotify() {
  if (!(await saveSettings(true))) return;
  showNotifySecrets(await api.get_settings());
  const line = $("#n-test-result");
  line.className = "row sub";
  line.textContent = "正在发送…";
  const r = await api.notify_test();
  line.className = "row sub " + (r.ok && r.all_ok ? "ok" : "bad");
  line.textContent = r.message;
}

function remoteLastText(last) {
  if (!last) return "";
  return `${last.ok ? "✓" : "✗"} ${fmtTime(last.time)} ${last.message}`;
}
function showRemoteInfo(s) {
  const url = s.pages_url || "";
  const btn = $("#s-remote-url");
  btn.hidden = !url;
  btn.textContent = url;
  $("#s-remote-url-none").hidden = !!url;
  const line = $("#s-remote-last");
  line.textContent = remoteLastText(s.remote_last);
  line.className = "row sub " + (s.remote_last ? (s.remote_last.ok ? "ok" : "bad") : "");
}

// 游戏服务器:“查一次”立刻查维护状态;输入提示用接口给的服务器名单(第一次打开设置时取一次)
async function checkServer() {
  const line = $("#s-server-result");
  line.className = "row sub";
  line.textContent = "正在查询…";
  const r = await api.check_server($("#s-game_server").value);
  line.className = "row sub " + (r.ok ? (r.server && r.server.maintenance ? "bad" : "ok") : "bad");
  line.textContent = (r.ok ? "✓ " : "✗ ") + r.message;
  if (r.server) renderServer(r.server);
}
let serverNamesLoaded = false;
async function loadServerNames() {
  if (serverNamesLoaded || !api.game_server_list) return;
  const r = await api.game_server_list();
  if (!r.ok || !r.names.length) return;
  serverNamesLoaded = true;
  const dl = $("#s-game_server-list");
  dl.innerHTML = "";
  r.names.forEach((n) => { const o = document.createElement("option"); o.value = n; dl.appendChild(o); });
}

// “我的时区”:输入提示(全部 IANA 时区名)和一句“北京时间 现在 13:20,你那里 06:20”
let tzNamesLoaded = false;
async function loadTzNames() {
  if (tzNamesLoaded || !api.tz_names) return;
  const names = await api.tz_names();
  tzNamesLoaded = true;
  const dl = $("#s-user_tz-list");
  dl.innerHTML = "";
  names.forEach((n) => { const o = document.createElement("option"); o.value = n; dl.appendChild(o); });
}
function showTzHint() {
  const tz = $("#s-user_tz").value.trim(), line = $("#s-tz-hint");
  const now = Date.now();
  if (!tz) { line.textContent = `北京时间现在 ${hhmm(now)}`; line.className = "row sub"; return; }
  const saved = state.userTz;
  state.userTz = tz;
  const ok = !!tzParts(now, tz);
  line.textContent = ok ? `北京时间现在 ${hhmm(now)},${tz} 现在 ${localDiffers(now) ? localHM(now) : hhmm(now) + "(和北京时间一样)"}`
                        : `✗ 不认识的时区名:${tz}`;
  line.className = "row sub " + (ok ? "ok" : "bad");
  state.userTz = saved;
}

async function checkAlas(fillSerial) {
  const info = await api.check_alas($("#s-root").value, $("#s-instance").value);
  const line = $("#s-adb"), sel = $("#s-instance");
  line.className = "row sub " + (info.ok ? "ok" : "bad");
  if (!info.root) { line.textContent = "✗ " + info.message; sel.innerHTML = ""; return; }
  $("#s-root").value = info.root;
  sel.innerHTML = "";
  info.instances.forEach((n) => { const o = document.createElement("option"); o.textContent = n; sel.appendChild(o); });
  sel.value = info.instance;
  line.textContent = info.ok ? `✓ 已找到 Alas 自带的 adb:${info.adb}` + (info.serial ? ` · ${info.instance} 的 Serial:${info.serial}` : "")
                             : "✗ " + info.message;
  if (fillSerial && info.serial) $("#s-serial").value = info.serial;
}

async function openSettings() {
  const s = await api.get_settings();
  $("#s-root").value = s.alas_root || "";
  $("#s-serial").value = s.serial || "";
  const sel = $("#s-instance");
  sel.innerHTML = `<option>${s.alas_instance || "alas"}</option>`;
  NUM_KEYS.forEach((k) => { $(`#s-${k}`).value = s[k] ?? ""; });
  BOOL_KEYS.forEach((k) => { $(`#s-${k}`).checked = !!s[k]; });
  $("#s-remote_repo").value = s.remote_repo || "";
  $("#s-remote_branch").value = s.remote_branch || "main";
  $("#s-remote_token").value = "";
  $("#s-remote_password").value = "";
  $("#s-remote_token").placeholder = s.has_token ? "已保存(留空不改)" : "粘贴 github_pat_…";
  $("#s-remote_password").placeholder = s.has_password ? "已设置(留空不改)" : "设置一个密码,至少 6 位";
  showRemoteInfo(s);
  NOTIFY_TEXT.forEach((k) => { $(`#s-${k}`).value = s[k] || ""; });
  ["fleet_surface", "fleet_sub"].forEach((k) => { $(`#s-${k}`).value = String(s[k] || 0); });
  showNotifySecrets(s);
  $("#n-test-result").textContent = "";
  const sv = (state.status || {}).server;
  $("#s-server-result").className = "row sub " + (sv ? (sv.maintenance || sv.error ? "bad" : "ok") : "");
  $("#s-server-result").textContent = sv ? (sv.error ? "✗ " : "✓ ") + (sv.error || sv.text || "") +
    (sv.notice ? `;官网公告:${sv.notice.active ? "正在维护" : "下次维护"} ${noticeSpan(sv.notice)}` :
     (sv.notice_error ? `;${sv.notice_error}` : "")) : "";
  loadServerNames();
  loadTzNames();
  showTzHint();
  $("#s-backup-last").textContent = s.backup_last ? `上次备份:${s.backup_last}` : "还没有备份过";
  $("#s-backup-result").textContent = "";
  fillBgSettings();
  loadSkin();
  document.querySelectorAll("#settings [data-lock]").forEach((el) => { el.disabled = !!s.running; });
  LIVE_IDS.forEach((id) => { document.getElementById(id).disabled = false; });
  $("#s-running-note").hidden = !s.running;
  openSheet("settings");
  checkAlas(false);
}

function settingsValues() {
  const v = { alas_root: $("#s-root").value, serial: $("#s-serial").value, alas_instance: $("#s-instance").value };
  NUM_KEYS.forEach((k) => { v[k] = $(`#s-${k}`).value.trim(); });
  BOOL_KEYS.forEach((k) => { v[k] = $(`#s-${k}`).checked; });
  v.remote_repo = $("#s-remote_repo").value.trim();
  v.remote_branch = $("#s-remote_branch").value.trim() || "main";
  v.remote_token = $("#s-remote_token").value.trim();
  v.remote_password = $("#s-remote_password").value;
  NOTIFY_TEXT.forEach((k) => { v[k] = $(`#s-${k}`).value.trim(); });
  ["fleet_surface", "fleet_sub"].forEach((k) => { v[k] = parseInt($(`#s-${k}`).value, 10) || 0; });
  v.notify_sckey = $("#n-sckey").value.trim();
  v.notify_mail_pass = $("#n-mail_pass").value.trim();
  v.notify_sckey_clear = notifyClear.sckey;
  v.notify_mail_pass_clear = notifyClear.mail_pass;
  return v;
}

async function saveSettings(keepOpen) {
  const r = await api.save_settings(settingsValues());
  if (!r.ok) { await alertBox("无法保存", r.message); return false; }
  if (keepOpen !== true) closeSheet("settings");
  pollService();
  load(true);         // 断档阈值跟着采样间隔变,图表重画一下
  return true;
}

// 设置里的“立即上传”:先保存(令牌、密码等),再上传;上传结果显示在下面那一行
async function uploadFromSettings() {
  if (!(await saveSettings(true))) return;
  const s = await api.get_settings();
  $("#s-remote_token").value = "";
  $("#s-remote_password").value = "";
  $("#s-remote_token").placeholder = s.has_token ? "已保存(留空不改)" : "粘贴 github_pat_…";
  $("#s-remote_password").placeholder = s.has_password ? "已设置(留空不改)" : "设置一个密码,至少 6 位";
  showRemoteInfo(s);
  const r = await api.remote_upload_now();
  if (!r.ok) { await alertBox("无法上传", r.message); return; }
  $("#s-remote-last").className = "row sub";
  $("#s-remote-last").textContent = "正在上传…";
  const timer = setInterval(async () => {
    const st = await api.get_settings();
    const status = state.status && state.status.remote;
    if (status && status.uploading) return;
    clearInterval(timer);
    showRemoteInfo(st);
  }, 1000);
}

async function onExpSwitch(e) {
  if (!e.target.checked) return;
  const yes = await modal("开启自动记录经验、魔方和勋章?", "开启后,程序会在下面条件全部满足时点击游戏:\n" +
    "· Alas 日志显示正在等待下个任务,而且至少还有 3 分钟\n· 游戏停在干净的主界面(没有遮罩、弹窗)\n\n" +
    "流程:点头像 → 读等级和经验 → 点返回;点建造 → 读心智魔方 → 点返回;点建造 → 支援 → 读勋章 → 点返回。" +
    "每步截图确认,出现意外会自动关闭本功能。\n\n在 Alas 等待期间暂停 Alas 去手动玩时,请先关掉本功能。",
    [{ label: "取消", value: false }, { label: "开启", kind: "primary", value: true }]);
  if (!yes) e.target.checked = false;
}

// ----- 补数字模板 -----
function showShot(info) {
  state.tmplPath = info ? info.path : null;
  const img = $("#t-img");
  if (info && info.thumb) img.src = info.thumb; else img.removeAttribute("src");
  $("#t-empty").style.display = info && info.thumb ? "none" : "";
  $("#t-name").textContent = info ? (info.error || `${info.name} · ${info.size}`) : "";
  $("#t-pick").textContent = info ? "换一张…" : "选择截图…";
  const zoom = info && info.zoom;
  $("#t-zoom").hidden = !zoom;
  if (zoom) { $("#t-zoom-img").src = info.zoom; $("#t-kind").textContent = `放大看 · ${info.kind}`; }
}
async function openTemplates() {
  ["oil", "coin", "level", "exp", "cube", "medal"].forEach((k) => { $(`#t-${k}`).value = ""; });
  $("#t-variant").checked = false;
  showShot(null);
  refreshTemplateHint();
  openSheet("tmpl");
  showShot(await api.latest_failed());
}
async function saveTemplates() {
  const form = { path: state.tmplPath, variant: $("#t-variant").checked };
  ["oil", "coin", "level", "exp", "cube", "medal"].forEach((k) => { form[k] = $(`#t-${k}`).value; });
  let r = await api.add_templates(form);
  if (!r.ok && r.confirm) {      // 填的数值和截图对不上:先确认,默认是回去改
    const go = await modal("数值可能填错了", r.message, [
      { label: "仍然保存", value: true }, { label: "回去修改", kind: "primary", value: false }]);
    if (!go) return;
    r = await api.add_templates({ ...form, force: true });
  }
  if (!r.ok) { await alertBox("无法保存模板", r.message); return; }
  closeSheet("tmpl");
  refreshTemplateHint();
  alertBox("模板已保存", r.message);
}

// ----- 出击统计 -----
let statsDays = [], statsPick = 0, statsMode = "day", moveStatsMode = null;
function statsCell(v, fmt) { return v === null || v === undefined ? "—" : (fmt ? fmt(v) : num(v)); }
function renderStats() {
  const tbl = $("#st-table");
  const week = statsMode === "week";
  const head = `<tr><th>${week ? "周" : "日期"}</th><th>出击</th><th>战斗</th><th>出击花油</th><th>每次出击</th><th>经验</th>` +
               "<th>每 1% 经验</th><th title=\"每花 100 油得到多少经验(出击花油)\">每 100 油经验</th></tr>";
  tbl.innerHTML = head + statsDays.map((d, i) => {
    const e = d.exp;
    const date = week ? d.label + (d.partial ? " 本周" : "") : d.day.slice(5) + (d.partial ? " 到现在" : "");
    const pct = e ? "+" + e.pct + "%" + (d.exp_from ? "*" : "") : "—";
    return `<tr data-i="${i}" class="${i === statsPick ? "on" : ""}"><td>${date}</td><td>${num(d.sorties)}</td><td>${num(d.battles)}</td>` +
      `<td>${statsCell(d.sortie_oil)}</td><td>${statsCell(d.oil_per_sortie)}</td>` +
      `<td>${pct}</td><td>${statsCell(d.oil_per_pct, (v) => num(v) + " 油")}</td>` +
      `<td class="strong">${statsCell(d.exp_per_100_oil)}</td></tr>`;
  }).join("");
  tbl.querySelectorAll("tr[data-i]").forEach((tr) => tr.addEventListener("click", () => { statsPick = +tr.dataset.i; renderStats(); }));
  const d = statsDays[statsPick];
  const box = $("#st-day");
  box.innerHTML = "";
  if (!d) return;
  // 周报没有时间线(一周七条太挤),只列每张图和说明
  $("#st-tl-head").hidden = $("#st-timeline").hidden = week;
  if (!week) {
    $("#st-tl-head").textContent = `${d.day}${d.partial ? "(到现在)" : ""} · Alas 任务时间线`;
    renderTimeline(d);
  }
  const h = document.createElement("h4");
  h.textContent = week ? `${d.label}${d.partial ? "(本周到现在)" : ""} · 每张图` : "每张图";
  box.appendChild(h);
  if (!d.maps.length) { const p = document.createElement("p"); p.textContent = week ? "这周没有出击" : "这天没有出击"; box.appendChild(p); }
  d.maps.forEach((m) => {
    const row = document.createElement("div"); row.className = "stats-map";
    row.innerHTML = `<span class="m"></span><span>${m.count} 次</span><span>${m.battles} 场</span><span>${num(m.oil)} 油</span><span class="avg">平均 ${num(Math.round(m.oil / Math.max(m.count, 1)))} 油/次</span>`;
    row.querySelector(".m").textContent = m.map;
    box.appendChild(row);
  });
  const notes = [];
  if (d.exp) notes.push(`经验 +${num(d.exp.exp)}(LV.${d.exp.from[0]} → LV.${d.exp.to[0]},+${d.exp.pct}%)` +
                        (d.exp_per_100_oil ? `,每 100 油得 ${num(d.exp_per_100_oil)} 经验` : "") +
                        (d.oil_per_10k_exp ? `,每 1 万经验 ${num(d.oil_per_10k_exp)} 油` : ""));
  if (d.exp_from) notes.push(`* 经验从 ${d.exp_from.slice(5)} 才开始记录:经验、每 1% 经验、每 100 油经验只按这之后的出击花油算`);
  if (week) notes.push(`这周有出击的天数:${d.active_days} 天`);
  notes.push(`${week ? "这周" : "全天"}石油共减少 ${num(d.oil_spent)}` + (d.oil_stop ? `,石油不够停止出击 ${d.oil_stop} 次` : ""));
  if (d.sorties > d.completed) notes.push(`${d.sorties - d.completed} 次出击没有正常打完(出错、撤退或被打断)`);
  notes.forEach((t) => { const p = document.createElement("p"); p.textContent = t; box.appendChild(p); });
}
// 任务时间线:每个任务一行(按当天总时长排,最多 9 行,其余归到“其它”),最上面一行是每次出击,下面是当天的石油曲线
const TL_COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ac8e68", "#5e5ce6", "#66d4cf"];
const tlColor = (name) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TL_COLORS[h % TL_COLORS.length]; };
let tlChart = null;
function renderTimeline(d) {
  const el = $("#st-timeline");
  const total = {};
  d.segments.forEach((s) => { total[s.name] = (total[s.name] || 0) + (s.end - s.start); });
  const ranked = Object.keys(total).sort((a, b) => total[b] - total[a]);
  const top = ranked.slice(0, 9), hasOther = ranked.length > 9;
  // “委托进行中”占两行高(最多 4 个委托同时进行,分成 4 条细道);第二行的名字留空
  const hasComm = (d.commissions || []).length > 0;
  const rows = ["出击", ...(hasComm ? ["委托进行中", " "] : []), ...top, ...(hasOther ? ["其它"] : [])];
  const rowH = 22, ganttH = rows.length * rowH, oilH = 92, top0 = 26, gap = 30;
  const narrow = el.clientWidth < 560;              // 手机上:左边任务名、右边石油刻度都收窄
  const gl = narrow ? 70 : 96, gr = narrow ? 42 : 60;
  el.style.height = `${top0 + ganttH + gap + oilH + 26}px`;
  const items = [];
  // 每项都给 6 个值:[行, 开始, 结束, 第几条细道, 细道数(0=普通块), 不透明度]
  d.sortie_list.forEach((s) => items.push({
    value: [0, s.start, Math.max(s.end, s.start + 60e3), 0, 0, 1],
    itemStyle: { color: tlColor(s.map) },
    tip: `<b>${s.map}</b> · ${hhmm(s.start)}–${hhmm(s.end)}<br>${s.battles} 场战斗 · ${num(s.oil)} 油${s.done ? "" : " · 没有正常打完"}`,
  }));
  const laneN = Math.max(d.commission_lanes || 1, 1);
  (d.commissions || []).forEach((c) => items.push({
    value: [1, c.start, c.end, c.lane, laneN, c.known_start ? 0.9 : 0.4],
    itemStyle: { color: tlColor(c.name) },
    tip: `<b>${c.name}</b><br>${c.known_start ? predWhen(c.start) + " 派出" : "派出时间不详(" + predWhen(c.start) + " 时已在进行)"}` +
         ` → ${predWhen(c.end)} 完成` + (c.known_start ? `(${fmtDur(c.end - c.start)})` : ""),
  }));
  d.segments.forEach((s) => {
    const row = top.includes(s.name) ? rows.indexOf(s.name) : rows.length - 1;
    items.push({
      value: [row, s.start, Math.max(s.end, s.start + 20e3), 0, 0, 1],
      itemStyle: { color: row === rows.length - 1 && hasOther ? css("--ink-3") : tlColor(s.name) },
      tip: `<b>${s.name}</b> · ${hhmm(s.start)}–${hhmm(s.end)}(${fmtDur(s.end - s.start)})`,
    });
  });
  const C = { ink: css("--ink"), ink2: css("--ink-2"), ink3: css("--ink-3"), grid: css("--grid"), hair: css("--hair"),
              surface: css("--surface"), oil: css("--oil") };
  const [w0, w1] = d.window;
  const xAxis = (i, show) => ({
    type: "time", gridIndex: i, min: w0, max: w1, position: i === 0 ? "top" : "bottom",
    axisTick: { show: false }, axisLine: { lineStyle: { color: C.hair } },
    axisLabel: { show, color: C.ink3, fontSize: narrow ? 10 : 11, formatter: "{HH}:{mm}", hideOverlap: true },
    splitLine: { show: true, lineStyle: { color: C.grid } }, splitNumber: 12,
  });
  const option = {
    animation: false,
    textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
    grid: [{ left: gl, right: gr, top: top0, height: ganttH }, { left: gl, right: gr, top: top0 + ganttH + gap, height: oilH }],
    xAxis: [xAxis(0, true), xAxis(1, true)],
    yAxis: [
      { type: "category", gridIndex: 0, data: rows, inverse: true, axisTick: { show: false }, axisLine: { show: false },
        axisLabel: { color: C.ink2, fontSize: narrow ? 11 : 12, width: gl - 10, overflow: "truncate" }, splitLine: { show: false } },
      { type: "value", gridIndex: 1, position: "right", splitNumber: 2, scale: true, name: "石油",
        nameTextStyle: { color: C.ink3, fontSize: 11 }, axisLabel: { color: C.ink3, fontSize: 11 },
        splitLine: { lineStyle: { color: C.grid } } },
    ],
    tooltip: {
      confine: true, backgroundColor: rgba(C.surface, 0.92), borderColor: C.hair, textStyle: { color: C.ink, fontSize: 12 },
      extraCssText: "border-radius:12px;", formatter: (p) => p.data && p.data.tip ? p.data.tip :
        (p.value ? `${hhmm(p.value[0])} · 石油 <b>${num(p.value[1])}</b>` : ""),
    },
    series: [
      { type: "custom", xAxisIndex: 0, yAxisIndex: 0, encode: { x: [1, 2], y: 0 }, data: items,
        dimensions: ["row", "start", "end", "lane", "lanes", "alpha"],
        renderItem(params, api) {
          const y = api.value(0), s = api.coord([api.value(1), y]), e = api.coord([api.value(2), y]);
          const band = api.size([0, 1])[1], cs = params.coordSys;
          let top = s[1] - band * 0.31, h = band * 0.62;
          const lane = api.value(3), lanes = api.value(4);
          if (lanes) {                       // 委托:两行高的区域分成 lanes 条细道
            const area = band * 1.8, laneH = area / lanes;
            top = s[1] - band * 0.4 + lane * laneH;
            h = Math.max(laneH - 1.5, 2);
          }
          const rect = echarts.graphic.clipRectByRect({ x: s[0], y: top, width: Math.max(e[0] - s[0], 1.5), height: h },
                                                      { x: cs.x, y: cs.y, width: cs.width, height: cs.height });
          return rect && { type: "rect", shape: { ...rect, r: 2 }, style: { fill: api.visual("color"), opacity: api.value(5) || 1 } };
        } },
      { type: "line", xAxisIndex: 1, yAxisIndex: 1, data: d.oil_curve, showSymbol: false, step: false,
        lineStyle: { color: C.oil, width: 1.5 }, areaStyle: { color: rgba(C.oil, 0.12) }, tooltip: { trigger: "item" } },
    ],
  };
  if (!tlChart) tlChart = echarts.init(el, null, { renderer: "canvas" });
  tlChart.resize();
  tlChart.setOption(option, true);
}

async function loadStats(mode) {
  statsMode = mode;
  if (moveStatsMode) moveStatsMode(mode);
  $("#st-note").textContent = mode === "week" ? "最近 8 周(周一到周日)· 点一行看那周每张图" : "最近 7 天 · 点一行看当天每张图";
  $("#st-table").innerHTML = `<tr><td>${mode === "week" ? "统计中…(第一次要读好几周的日志,可能要半分钟)" : "统计中…"}</td></tr>`;
  $("#st-day").innerHTML = "";
  const r = await api.sortie_stats(7, mode);
  if (statsMode !== mode) return;              // 等待期间又切换了
  if (!r.ok) { $("#st-table").innerHTML = `<tr><td>${r.message}</td></tr>`; return; }
  statsDays = r.days;
  statsPick = 0;
  renderStats();
}
async function openStats() {
  openSheet("stats");
  if (!moveStatsMode) moveStatsMode = segmented("st-mode", statsMode, loadStats);
  loadStats(statsMode);
}

// ----- 每日报告 -----
function mdToHtml(md) {       // 日报用到的几种 Markdown:### 标题、- 列表(两格缩进是二级)、**加粗**
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  let html = "", inList = false;
  for (const line of md.split("\n")) {
    const li = /^(\s*)- (.*)$/.exec(line);
    if (li) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li class="${li[1].length ? "sub" : ""}">${inline(li[2])}</li>`;
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    if (line.startsWith("### ")) html += `<h4>${inline(line.slice(4))}</h4>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  return html + (inList ? "</ul>" : "");
}
let moveReportTab = null, reportWhich = "yesterday";
async function loadReport(which) {
  reportWhich = which;
  if (moveReportTab) moveReportTab(which);
  $("#r-body").textContent = "生成中…";
  $("#r-note").textContent = "";
  const r = await api.daily_report(which);
  if (!r.ok) { $("#r-body").textContent = r.message; return; }
  $("#r-title").textContent = r.title;
  $("#r-body").innerHTML = mdToHtml(r.body);
}
function openReport() {
  openSheet("report");        // 先显示再建分段控件,否则按钮宽度是 0
  if (!moveReportTab) moveReportTab = segmented("r-tabs", "yesterday", loadReport);
  loadReport("yesterday");
}
async function sendReport() {
  $("#r-note").textContent = "正在发送…";
  const r = await api.send_report(reportWhich);
  $("#r-note").textContent = r.message || "";
}

// ----- 菜单里的其它操作 -----
async function menuAction(act) {
  closeMenu();
  let r;
  if (act === "settings") return openSettings();
  if (act === "tmpl") return openTemplates();
  if (act === "report") return openReport();
  if (act === "stats") return openStats();
  if (act === "exp") r = await api.record_exp_now();
  if (act === "remote") r = await api.remote_upload_now();
  if (act === "import") {
    const yes = await modal("导入 Alas 历史读数", "从 Alas 的日志文件里导入它以前识别过的石油/物资读数。\n只读日志文件;已导入过的不会重复。日志很多时需要几十秒。",
      [{ label: "取消", value: false }, { label: "开始导入", kind: "primary", value: true }]);
    if (!yes) return;
    r = await api.import_history();
  }
  if (act === "export") {
    const url = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: css("--surface") });
    r = await api.export_png(url);
    if (r && !r.ok && !r.message) return;      // 取消了保存对话框
  }
  if (act.startsWith("open-")) r = await api.open_path(act.slice(5));
  if (r && !r.ok && r.message) alertBox("做不了", r.message);
  pollService();
}

// 右栏 Alas 卡片里的两个标签:Alas 状态 / 活动日志
let moveSideTab = null;
function setSideTab(v) {
  if (v === "log" && document.body.classList.contains("remote")) v = "alas";   // 远程网页没有活动日志
  $("#alas-pane").hidden = v !== "alas";
  $("#work-pane").hidden = v !== "work";
  $("#fleet-pane").hidden = v !== "fleet";
  $("#log-pane").hidden = v !== "log";
  if (moveSideTab) moveSideTab(v);
  store.set("sidetab", v);
  if (v === "log") { const log = $("#log"); log.scrollTop = 0; }
}

// 程序图标:换掉左上角默认的水滴图标(src 为空或图片加载失败就保留水滴)
function showLogo(src) {
  const img = $("#brand-logo");
  if (!img || !src) return;
  img.onload = () => { img.hidden = false; img.closest(".brand").classList.add("has-logo"); };
  img.src = src;
  if (document.body.classList.contains("remote")) {      // 远程网页:浏览器标签页图标、添加到主屏幕的图标
    for (const rel of ["icon", "apple-touch-icon"]) {
      let link = document.querySelector(`link[rel="${rel}"]`);
      if (!link) { link = document.createElement("link"); link.rel = rel; document.head.appendChild(link); }
      link.href = src;
    }
  }
}

// 物资、石油、魔方卡片标题前的图标(换掉单色圆点);图片加载失败就保留圆点
function showTileIcons(map) {
  // 图表标题也用(只用已经加载成功的图标,免得画出一个空图)
  ["coin", "oil"].forEach((k) => {
    if (!map || !map[k]) return;
    const probe = new Image();
    probe.onload = () => { state.icons = { ...(state.icons || {}), [k]: map[k] }; if (state.view) render(state.view, true); };
    probe.src = map[k];
  });
  document.querySelectorAll("img.tile-icon").forEach((img) => {
    const src = map && map[img.dataset.icon];
    if (!src) return;
    img.onload = () => {
      img.hidden = false;
      const label = img.closest(".tile-label");          // 卡片标题:有图标就隐藏圆点(勋章那一行本来没有圆点)
      if (label) label.classList.add("has-icon");
    };
    img.src = src;
  });
}

function initPanels() {
  if (!document.body.classList.contains("remote")) {
    showLogo("logo.png");
    showTileIcons({ coin: "icons/coin.png", oil: "icons/oil.png", cube: "icons/cube.png", medal: "icons/medal.png" });
  }
  {   // 远程网页也有标签(Alas / 委托科研),只是没有“活动”
    let tab = store.get("sidetab", "alas");
    if (tab === "log" && document.body.classList.contains("remote")) tab = "alas";
    moveSideTab = segmented("side-tabs", tab, setSideTab);
    setSideTab(tab);
    // 远程网页的数据 10 分钟才来一次:倒计时(“还有 X 分”)每 30 秒按手机时间重算一次
    if (document.body.classList.contains("remote")) setInterval(() => { renderAlas(); renderWork(); }, 30e3);
  }
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-more").addEventListener("click", (e) => {
    e.stopPropagation();
    const m = $("#menu");
    const s = state.status || {};
    m.querySelector('[data-act="import"]').disabled = !!(s.running || s.busy);
    m.querySelector('[data-act="exp"]').disabled = !!s.busy;
    m.classList.toggle("show");
    $("#btn-more").classList.toggle("on", m.classList.contains("show"));
  });
  $("#menu").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) menuAction(b.dataset.act); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#menu")) closeMenu(); });
  $("#tmpl-hint").addEventListener("click", openTemplates);
  $("#alas-hint").addEventListener("click", () => {        // 点红色提示:切到 Alas 标签,滚到卡片并闪一下
    setSideTab("alas");
    const card = $("#alascard");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash");
  });
  $("#remote-hint").addEventListener("click", async () => {
    await openSettings();
    const box = document.querySelector("#settings .sheet-body");
    box.scrollTop = box.scrollHeight;       // 直接滚到“远程查看”那一组
  });
  document.querySelectorAll(".sheet-layer").forEach((layer) => {
    layer.addEventListener("mousedown", (e) => { if (e.target === layer) closeSheet(layer.id); });
    layer.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheet(layer.id)));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("#modal").classList.contains("show")) return;
    closeMenu();
    document.querySelectorAll(".sheet-layer.show").forEach((l) => closeSheet(l.id));
  });
  $("#s-browse").addEventListener("click", async (e) => {
    e.preventDefault();
    const p = await api.browse_folder($("#s-root").value);
    if (p) { $("#s-root").value = p; checkAlas(true); }
  });
  $("#s-root").addEventListener("change", () => checkAlas(true));
  $("#s-instance").addEventListener("change", () => checkAlas(true));
  $("#s-exp_auto").addEventListener("change", onExpSwitch);
  $("#s-save").addEventListener("click", () => saveSettings());
  $("#s-remote-upload").addEventListener("click", (e) => { e.preventDefault(); uploadFromSettings(); });
  $("#n-test").addEventListener("click", (e) => { e.preventDefault(); testNotify(); });
  $("#s-check-server").addEventListener("click", (e) => { e.preventDefault(); checkServer(); });
  $("#s-user_tz").addEventListener("input", showTzHint);
  // 数据备份:立即备份 / 打开备份文件夹 / 从备份恢复(选文件 → 输查看密码 → 解到新文件夹)
  $("#s-backup-now").addEventListener("click", async (e) => {
    e.preventDefault();
    const line = $("#s-backup-result");
    line.className = "row sub"; line.textContent = "正在备份并上传…";
    const r = await api.backup_now();
    line.className = "row sub " + (r.ok ? "ok" : "bad");
    line.textContent = (r.ok ? "✓ " : "✗ ") + r.message;
    if (r.ok) $("#s-backup-last").textContent = `上次备份:${bjDay(Date.now())}`;
  });
  $("#s-backup-open").addEventListener("click", async (e) => {
    e.preventDefault();
    const r = await api.open_path("backups");
    if (r && !r.ok) alertBox("还没有备份", "备份文件夹还不存在,先点“立即备份”。");
  });
  $("#s-backup-restore").addEventListener("click", async (e) => {
    e.preventDefault();
    const path = await api.pick_backup_file();
    if (!path) return;
    const pw = await askPassword("从备份恢复", "输入“远程查看”的查看密码(备份是用它加密的)。\n会解到程序旁边新的 restored_日期 文件夹,不会覆盖现在的数据。");
    if (pw === null) return;
    const r = await api.restore_backup(path, pw);
    alertBox(r.ok ? "已恢复" : "恢复失败", r.message);
  });
  $("#r-send").addEventListener("click", sendReport);
  $("#fleet-pending").addEventListener("click", openFleetLabel);
  $("#fl-save").addEventListener("click", saveFleetLabel);
  $("#n-sckey-clear").addEventListener("click", (e) => { e.preventDefault(); clearNotifySecret("sckey"); });
  $("#n-mail_pass-clear").addEventListener("click", (e) => { e.preventDefault(); clearNotifySecret("mail_pass"); });
  $("#s-remote-url").addEventListener("click", (e) => { e.preventDefault(); api.open_url($("#s-remote-url").textContent); });
  $("#t-pick").addEventListener("click", async () => { const r = await api.pick_image(); if (r) showShot(r); });
  $("#t-save").addEventListener("click", saveTemplates);
  refreshTemplateHint();
}

// ---------- Alas 状态卡片 ----------
const ALAS_STATE = {
  running: "运行中", waiting: "等待中", error: "出错", stalled: "可能卡住", stopped: "未运行", unknown: "未知",
};
function fmtDur(ms) {         // 1 小时 5 分 / 12 分 / 不到 1 分
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 1) return "不到 1 分";
  const h = Math.floor(m / 60);
  return h ? `${h} 小时${m % 60 ? " " + (m % 60) + " 分" : ""}` : `${m} 分`;
}
function renderAlas() {
  const a = state.alas;
  if (!a) return;
  const now = Date.now() + (state.alasSkew || 0);
  const hint = $("#alas-hint");
  if (hint) hint.hidden = a.state !== "error";
  const badge = $("#alas-badge");
  badge.className = "alas-badge " + a.state;
  badge.querySelector("span").textContent = ALAS_STATE[a.state] || a.state;
  let big = "", small = "";
  if (a.state === "error") {
    $("#alas-now").innerHTML = "";
    const e = document.createElement("div");
    e.className = "err";
    e.textContent = a.error || "需要人工处理";
    const s = document.createElement("div");
    s.className = "small";
    s.textContent = `${a.since ? hhmm(a.since) + " 出错后 Alas 已停止" : "Alas 已停止"}${a.name ? " · 当时在执行「" + a.name + "」" : ""}`;
    $("#alas-now").append(e, s);
  } else {
    if (a.state === "running") {
      big = a.name ? `正在执行「${a.name}」` : "正在选择下一个任务";
      small = a.since ? `${hhmm(a.since)} 开始 · 已运行 ${fmtDur(now - a.since)}` : "";
    } else if (a.state === "waiting") {
      big = `下一个:「${a.name}」`;
      small = a.until ? `${hhmm(a.until)}${localNote(a.until)} 开始 · 还有 ${fmtDur(a.until - now)}` : "";
    } else if (a.state === "stalled") {
      big = a.name ? `「${a.name}」可能卡住了` : "可能卡住了";
      small = a.log_time ? `已经 ${fmtDur(now - a.log_time)} 没有新日志` : "";
    } else if (a.state === "stopped") {
      big = "Alas 没有在运行";
      small = a.until ? `原定 ${hhmm(a.until)} 执行「${a.name}」,但没有开始` : "";
    } else {
      big = a.error || "还没有读到 Alas 的调度记录";
    }
    $("#alas-now").innerHTML = "";
    const b = document.createElement("div"); b.className = "big"; b.textContent = big;
    const s = document.createElement("div"); s.className = "small"; s.textContent = small;
    $("#alas-now").append(b, s);
  }
  const list = $("#alas-list");
  list.innerHTML = "";
  if (a.pending && a.pending.length && a.state !== "error") {
    const h = document.createElement("h4"); h.textContent = `队列中 · ${a.pending.length}`;
    const chips = document.createElement("div"); chips.className = "alas-chips";
    a.pending.forEach((p) => { const c = document.createElement("span"); c.textContent = p.name; chips.appendChild(c); });
    list.append(h, chips);
  }
  renderEmotion(a.emotion || [], now, list);       // 心情放在等待列表前面:两行就能看到,也解释了主线图为什么还没开始
  if (a.waiting && a.waiting.length) {
    const h = document.createElement("h4"); h.textContent = "等待中";
    list.appendChild(h);
    const top = window.innerHeight < 780 ? 3 : 5;        // 窗口矮时少列几个,给活动日志留地方
    a.waiting.slice(0, top).forEach((w) => {
      const row = document.createElement("div"); row.className = "alas-row";
      const t = document.createElement("span"); t.className = "t"; t.textContent = hhmm(w.next);
      const n = document.createElement("span"); n.className = "n"; n.textContent = w.name;
      const i = document.createElement("span"); i.className = "in"; i.textContent = w.next > now ? fmtDur(w.next - now) + "后" : "已到时间";
      row.append(t, n, i);
      list.appendChild(row);
    });
  }
  if (document.body.classList.contains("remote") && state.status && state.status.generated) {
    const f = document.createElement("div");      // 远程网页:提醒这是多久之前的状态
    f.className = "alas-foot";
    f.textContent = `状态来自 ${hhmm(state.status.generated)} 上传的数据`;
    list.appendChild(f);
  }
}
// 舰队心情:按 Alas 的规则(每 6 分钟恢复 speed,不超过 max)从记录值算到现在
const EMO_STEP = 360e3;
function emoAt(f, now) {
  const steps = Math.max(Math.floor(now / EMO_STEP) - Math.floor(f.record / EMO_STEP), 0);
  return Math.min(Math.max(f.value, 0) + f.speed * steps, f.max);
}
function emoReach(f, cur, target, now) {      // 心情到 target 的时间(毫秒时间戳)
  const steps = Math.ceil((target - cur) / f.speed);
  return (Math.floor(now / EMO_STEP) + steps) * EMO_STEP;
}
function renderEmotion(tasks, now, list) {
  tasks.forEach((t) => {
    const h = document.createElement("h4");
    h.textContent = `舰队心情 · ${t.name}`;
    list.appendChild(h);
    t.fleets.forEach((f) => {
      const cur = emoAt(f, now), low = cur < f.limit;
      const row = document.createElement("div"); row.className = "emo-row" + (low ? " low" : "");
      const n = document.createElement("span"); n.className = "en"; n.textContent = `第 ${f.fleet} 舰队`;
      const bar = document.createElement("span"); bar.className = "emo-bar";
      const fill = document.createElement("i"); fill.style.width = `${(100 * cur) / f.max}%`;
      const mark = document.createElement("b"); mark.style.left = `${(100 * f.limit) / f.max}%`;
      mark.title = `控制线 ${f.limit}(${f.control}):低于它 Alas 不出击`;
      bar.append(fill, mark);
      const v = document.createElement("span"); v.className = "ev"; v.textContent = `${cur}/${f.max}`;
      const r = document.createElement("span"); r.className = "er";
      if (low) r.textContent = `${hhmm(emoReach(f, cur, f.limit, now))} 回到 ${f.limit}`;
      else r.textContent = cur >= f.max ? "已满" : `${hhmm(emoReach(f, cur, f.max, now))} 回满`;
      row.append(n, bar, v, r);
      list.appendChild(row);
    });
  });
  if (tasks.length) {
    const s = document.createElement("div"); s.className = "work-note";
    const f = tasks[0].fleets[0];
    s.textContent = `每 6 分钟 +${f.speed} · 红线是控制线 ${f.limit}(${f.control}),低于它 Alas 等恢复再出击`;
    list.appendChild(s);
  }
}

async function pollAlas() {
  try {
    const a = await api.alas_status();
    state.alasSkew = a.now ? a.now - Date.now() : 0;     // 用电脑上 Python 的时间算倒计时
    state.alas = a;
    renderAlas();
    if (api.alas_work) { state.work = await api.alas_work(); renderWork(); }
    if (api.fleet_view) { state.fleet = await api.fleet_view(); renderFleet(); }
  } catch (e) { report(e); }
}

// ---------- 编队(选定舰队每条船的名字和等级)----------
function renderFleet() {
  const f = state.fleet;
  const list = $("#fleet-list");
  if (!f || !list) return;
  list.innerHTML = "";
  if (!f.targets || !f.targets.length) {
    list.appendChild(workRow("", "还没有选择要追踪的舰队(设置 → 经验、魔方和勋章)", ""));
  } else if (!f.fleets.length) {
    list.appendChild(workRow("", "还没有记录(在 Alas 空闲时自动记录,或者用 ··· → 立即记录)", ""));
  }
  (f.fleets || []).forEach((fl) => {
    const h = document.createElement("h4");
    h.className = "fleet-h";
    h.textContent = `${fl.fleet} · ${fl.time.slice(5, 16)}`;
    list.appendChild(h);
    fl.rows.forEach((r) => {
      if (r.status === "empty") return;
      const row = document.createElement("div"); row.className = "fleet-row" + (r.status === "ok" ? "" : " unknown");
      const a = document.createElement("span"); a.className = "fs"; a.textContent = r.label;
      const n = document.createElement("span"); n.className = "fn"; n.textContent = r.name || "未识别的舰船";
      const l = document.createElement("span"); l.className = "fl"; l.textContent = r.level ? `Lv.${r.level}` : "Lv.?";
      const g = document.createElement("span"); g.className = "fg";
      if (r.first_level && r.level > r.first_level) {
        g.textContent = `+${r.level - r.first_level}`;
        g.title = `${r.first_time.slice(5, 16)} 记录时是 Lv.${r.first_level}`;
      }
      row.append(a, n, l, g);
      list.appendChild(row);
    });
  });
  const btn = $("#fleet-pending");
  const remote = document.body.classList.contains("remote");
  btn.hidden = remote || !f.pending;
  btn.textContent = `有 ${f.pending} 项没认出来,去标注 →`;
  $("#fleet-foot").textContent = f.fleets && f.fleets.length ? "“+N”是从第一次记录到现在升了几级" : "";
}
// 官方舰船名单(只取一次),用于输入提示和“名字不在名单里”的提醒
let shipNames = null;
async function loadShipNames() {
  if (shipNames || !api.ship_name_list) return shipNames || [];
  shipNames = await api.ship_name_list();
  const dl = $("#ship-names");
  dl.innerHTML = "";
  shipNames.forEach((n) => { const o = document.createElement("option"); o.value = n; dl.appendChild(o); });
  return shipNames;
}
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function closestNames(name, list) {
  return list.map((n) => [n, editDistance(name, n)]).filter(([, d]) => d <= Math.max(1, Math.floor(name.length / 2)))
             .sort((x, y) => x[1] - y[1]).slice(0, 3).map(([n]) => n);
}

async function openFleetLabel() {
  loadShipNames();
  const items = await api.fleet_pending();
  const box = $("#fl-items");
  box.innerHTML = "";
  if (!items.length) box.textContent = "没有需要标注的内容。";
  items.forEach((it) => {
    const row = document.createElement("div"); row.className = "fl-item";
    const img = document.createElement("img"); img.src = it.image; img.alt = "";
    const meta = document.createElement("div"); meta.className = "fl-meta";
    meta.textContent = `${it.fleet} · ${it.label} · ${it.type === "name" ? "舰船名字" : "等级(只填数字)"}`;
    const input = document.createElement("input");
    input.dataset.id = it.id;
    input.dataset.type = it.type;
    input.placeholder = it.type === "name" ? "舰船名字(输入会有提示)" : "如 120";
    if (it.type === "name") input.setAttribute("list", "ship-names");
    else input.className = "num";
    meta.appendChild(input);
    row.append(img, meta);
    box.appendChild(row);
  });
  openSheet("fleetlabel");
}
async function saveFleetLabel() {
  const values = {};
  document.querySelectorAll("#fl-items input").forEach((i) => { if (i.value.trim()) values[i.dataset.id] = i.value.trim(); });
  // 填的名字不在官方名单里:可能是自定义名字,也可能打错了 —— 列出来,附上最接近的官方名字,让你确认
  const list = await loadShipNames();
  if (list.length) {
    const odd = [...document.querySelectorAll('#fl-items input[data-type="name"]')]
      .map((i) => i.value.trim()).filter((n) => n && !list.includes(n));
    if (odd.length) {
      const lines = odd.map((n) => { const c = closestNames(n, list); return `· ${n}` + (c.length ? `(官方名单里相近的:${c.join("、")})` : ""); });
      const go = await modal("有名字不在官方名单里", lines.join("\n") +
        "\n\n如果是誓约后改的自定义名字,选“就这样保存”;如果是打错了,选“回去修改”。",
        [{ label: "就这样保存", value: true }, { label: "回去修改", kind: "primary", value: false }]);
      if (!go) return;
    }
  }
  const r = await api.fleet_label(values);
  closeSheet("fleetlabel");
  state.fleet = await api.fleet_view();
  renderFleet();
  alertBox("编队识别", r.message);
}

// ---------- 委托和科研(从 Alas 日志读)----------
function dayTime(ms) {        // 今天的写 05:10,其它天写 11-23 05:10(北京时间)
  const today = Date.now() + (state.alasSkew || 0);
  return bjDay(ms) === bjDay(today) ? hhmm(ms) : `${mmdd(ms)} ${hhmm(ms)}`;
}
function workRow(time, name, right, cls) {
  const row = document.createElement("div"); row.className = "alas-row" + (cls ? " " + cls : "");
  const t = document.createElement("span"); t.className = "t"; t.textContent = time;
  const n = document.createElement("span"); n.className = "n"; n.textContent = name;
  const i = document.createElement("span"); i.className = "in"; i.textContent = right;
  row.append(t, n, i);
  return row;
}
function renderWork() {
  const w = state.work;
  if (!w) return;
  const now = Date.now() + (state.alasSkew || 0);
  const comm = $("#w-comm"), res = $("#w-res");
  comm.innerHTML = ""; res.innerHTML = "";
  const c = w.commission;
  if (c) {
    const run = c.running || [];
    const max = c.slots ? c.slots[1] : 4;
    $("#w-comm-head").textContent = `委托 · 进行中 ${run.filter((r) => r.finish > now).length}/${max}`;
    run.forEach((r) => {
      const done = r.finish <= now;
      comm.appendChild(workRow(hhmm(r.finish), r.name, done ? "已完成,等 Alas 收取" : fmtDur(r.finish - now) + "后", done ? "done" : ""));
    });
    if (!run.length) comm.appendChild(workRow("", "没有进行中的委托", ""));
    const left = [];
    if (c.daily_left) left.push(`每日委托还有 ${c.daily_left} 个没做`);
    if (c.urgent_left) left.push(`紧急委托 ${c.urgent_left} 个`);
    if (left.length) { const s = document.createElement("div"); s.className = "work-note"; s.textContent = left.join(" · "); comm.appendChild(s); }
  } else {
    $("#w-comm-head").textContent = "委托";
    comm.appendChild(workRow("", "日志里还没有委托记录(等 Alas 运行一次委托任务)", ""));
  }
  const r = w.research;
  if (r) {
    $("#w-res-head").textContent = `科研 · 队列 ${r.queued}/${r.size}`;
    if (r.first_end) {
      res.appendChild(workRow(hhmm(r.first_end), "当前项目完成",
        r.first_end <= now ? "已完成,等 Alas 收取" : fmtDur(r.first_end - now) + "后", r.first_end <= now ? "done" : ""));
    }
    const notes = [];
    if (r.recent && r.recent.length) notes.push("最近加入:" + r.recent.join("、"));
    notes.push(`今天完成 ${r.received_today} 个项目`);
    if (r.queued < r.size) notes.push(`队列还有 ${r.size - r.queued} 格空着`);
    notes.forEach((t) => { const s = document.createElement("div"); s.className = "work-note"; s.textContent = t; res.appendChild(s); });
  } else {
    $("#w-res-head").textContent = "科研";
    res.appendChild(workRow("", "日志里还没有科研记录(等 Alas 运行一次科研任务)", ""));
  }
  const scans = [];
  if (c) scans.push(`委托 ${dayTime(c.scan)}`);
  if (r) scans.push(`科研 ${dayTime(r.scan)}`);
  $("#w-foot").textContent = w.error || (scans.length ? `Alas 最近一次查看:${scans.join(" · ")}` : "");
}

// ---------- 背景壁纸(只在桌面程序里;远程网页不显示)----------
const BG_CHECK_MS = 5 * 60e3;        // 每 5 分钟问一次:随机轮换是否该换了
function setBgVars(b) {
  const root = document.documentElement.style;
  root.setProperty("--bg-blur", `${b.blur}px`);
  root.setProperty("--bg-dim", String(b.dim));
}
function showBgImage(url) {
  // 两层轮流:新图加载好后淡入,旧图淡出
  return new Promise((resolve) => {
    const layers = [$("#bg"), $("#bg2")];
    const next = layers.find((l) => !l.classList.contains("show")) || layers[0];
    const img = new Image();
    img.onload = () => {
      next.style.backgroundImage = `url("${url}")`;
      requestAnimationFrame(() => {
        layers.forEach((l) => l.classList.toggle("show", l === next));
        document.body.classList.add("has-bg");
        resolve(true);
      });
    };
    img.onerror = () => resolve(false);
    img.src = url;
  });
}
async function applyBackground(forceNext) {
  if (document.body.classList.contains("remote") || !api.get_background) return;
  try {
    const b = await api.get_background(state.bg ? state.bg.key : null, !!forceNext);
    setBgVars(b);
    if (b.image) {
      await showBgImage(b.image);
      state.bgImage = b.image;
    } else if (!b.same) {
      document.body.classList.remove("has-bg");         // 关闭了背景(或者拿不到)
      state.bgImage = null;
    }
    state.bg = b;
    $("#bg-credit").textContent = b.key ? `壁纸:${b.title}${b.artist ? " · 画师 " + b.artist : ""} · ${b.source}` : "";
    fillBgSettings();
  } catch (e) { report(e); }
}
const loadBackground = () => applyBackground(false);

// 设置里的“背景”分组
function fillBgSettings() {
  const b = state.bg;
  if (!b) return;
  $("#b-mode").value = b.mode;
  $("#b-rotate").value = b.rotate_h;
  $("#b-rotate-row").style.display = b.mode === "random" ? "" : "none";
  $("#b-blur").value = b.blur;
  $("#b-dim").value = b.dim;
  $("#b-blur-val").textContent = `${b.blur}px`;
  $("#b-dim-val").textContent = `${Math.round(b.dim * 100)}%`;
  const thumb = $("#b-thumb");
  if (state.bgImage && b.mode !== "off") thumb.src = state.bgImage; else thumb.removeAttribute("src");
  $("#b-title").textContent = b.mode === "off" ? "背景已关闭" : (b.title || "正在加载…");
  $("#b-artist").textContent = b.mode === "off" ? "" : (b.artist ? `画师 ${b.artist}` : (b.source || ""));
}
async function setBackground(opts) {
  const r = await api.set_background(opts);
  if (!r.ok) { await alertBox("无法更改背景", r.message); fillBgSettings(); return; }
  $("#b-title").textContent = "正在加载…";
  await applyBackground(false);
}

// 选择壁纸面板
async function openPicker() {
  openSheet("picker");
  const grid = $("#p-grid");
  grid.innerHTML = '<div class="log-empty">正在读取官网壁纸列表…</div>';
  const r = await api.wallpaper_list();
  $("#p-count").textContent = r.items.length ? `共 ${r.items.length} 张` : "";
  if (!r.items.length) { grid.innerHTML = '<div class="log-empty">读不到官网的壁纸列表(没有网络?)</div>'; return; }
  grid.innerHTML = "";
  for (const it of r.items) {
    const b = document.createElement("button");
    b.className = "wall" + (it.id === r.current && r.mode !== "latest" && r.mode !== "local" && r.mode !== "off" ? " on" : "");
    b.dataset.id = it.id;
    b.title = `${it.title}${it.artist ? " · " + it.artist : ""}`;
    const img = document.createElement("img");
    img.className = "w-img";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    img.addEventListener("error", () => {
      // 加载失败:过一会儿重试一次;还不行(个别原图太大,官网服务器生成不了缩略图)就显示占位,点了照样能设为背景
      if (!img.dataset.retried) {
        img.dataset.retried = "1";
        setTimeout(() => { img.src = it.thumb + "&retry=1"; }, 1500);
        return;
      }
      const ph = document.createElement("span");
      ph.className = "w-img w-placeholder";
      ph.textContent = "暂无缩略图";
      img.replaceWith(ph);
    });
    img.src = it.thumb;
    const t = document.createElement("span"); t.className = "w-title"; t.textContent = it.title;
    const a = document.createElement("span"); a.className = "w-artist"; a.textContent = it.artist ? `画师 ${it.artist}` : "";
    b.append(img, t, a);
    b.addEventListener("click", async () => {
      grid.querySelectorAll(".wall").forEach((x) => x.classList.toggle("on", x === b));
      b.classList.add("loading");
      await setBackground({ id: it.id });          // 选了一张 = 固定这一张
      b.classList.remove("loading");
      closeSheet("picker");
    });
    grid.appendChild(b);
  }
}

function initBackgroundControls() {
  $("#b-mode").addEventListener("change", async (e) => {
    const mode = e.target.value;
    if (mode === "local" && !(state.bg && state.bg.local)) {      // 还没选过本机图片:先选
      const r = await api.pick_local_image();
      if (!r.ok) { if (r.message) await alertBox("无法使用这张图片", r.message); fillBgSettings(); return; }
      $("#b-title").textContent = "正在加载…";
      return applyBackground(false);
    }
    if (mode === "fixed" && !(state.bg && state.bg.fixed_id)) {  // 还没选过固定哪张:打开挑选面板
      fillBgSettings();
      return openPicker();
    }
    setBackground({ mode });
  });
  $("#b-pick").addEventListener("click", (e) => { e.preventDefault(); openPicker(); });
  $("#b-local").addEventListener("click", async (e) => {
    e.preventDefault();
    const r = await api.pick_local_image();
    if (!r.ok) { if (r.message) alertBox("无法使用这张图片", r.message); return; }
    $("#b-title").textContent = "正在加载…";
    applyBackground(false);
  });
  $("#b-rotate").addEventListener("change", (e) => setBackground({ rotate_h: e.target.value }));
  $("#b-next").addEventListener("click", (e) => { e.preventDefault(); $("#b-title").textContent = "正在加载…"; applyBackground(true); });
  // 滑块:拖动时实时预览,松手时保存
  $("#b-blur").addEventListener("input", (e) => {
    document.documentElement.style.setProperty("--bg-blur", `${e.target.value}px`);
    $("#b-blur-val").textContent = `${e.target.value}px`;
  });
  $("#b-dim").addEventListener("input", (e) => {
    document.documentElement.style.setProperty("--bg-dim", e.target.value);
    $("#b-dim-val").textContent = `${Math.round(e.target.value * 100)}%`;
  });
  $("#b-blur").addEventListener("change", (e) => api.set_background({ blur: e.target.value }).then(() => { if (state.bg) state.bg.blur = +e.target.value; }));
  $("#b-dim").addEventListener("change", (e) => api.set_background({ dim: e.target.value }).then(() => { if (state.bg) state.bg.dim = +e.target.value; }));
  setInterval(() => applyBackground(false), BG_CHECK_MS);
}

// ---------- 设置里的“Alas 换肤”分组(改动立即生效,作用到已打开的 Alas 窗口)----------
const SKIN_COLORS = [["#007aff", "蓝色"], ["#af52de", "紫色"], ["#ff2d55", "粉色"], ["#ff3b30", "红色"],
                     ["#ff9500", "橙色"], ["#ffcc00", "黄色"], ["#34c759", "绿色"], ["#8e8e93", "石墨色"]];
let skin = null;
async function loadSkin() {
  if (!api.get_alas_skin) return;
  try { skin = await api.get_alas_skin(); fillSkin(); } catch (e) { report(e); }
}
function fillSkin() {
  if (!skin) return;
  $("#k-enabled").checked = !!skin.alas_skin;
  $("#k-theme").value = skin.alas_skin_theme;
  $("#k-radius").value = String(skin.alas_skin_radius);
  if (!$("#k-radius").value) $("#k-radius").value = "12";
  $("#k-bg").value = skin.alas_skin_bg;
  $("#k-dim").value = skin.alas_skin_dim;
  $("#k-dim-val").textContent = `${Math.round(skin.alas_skin_dim * 100)}%`;
  $("#k-dim-row").style.display = skin.alas_skin_bg === "wallpaper" ? "" : "none";
  const acc = (skin.alas_skin_accent || "").toLowerCase();
  let preset = false;
  $("#k-swatches").querySelectorAll(".k-swatch[data-c]").forEach((b) => {
    const on = b.dataset.c === acc;
    preset = preset || on;
    b.classList.toggle("on", on);
  });
  const custom = $("#k-custom");
  custom.value = acc || "#007aff";
  custom.parentElement.classList.toggle("on", !preset);
  const off = !skin.alas_skin;
  ["#k-theme", "#k-radius", "#k-bg", "#k-dim"].forEach((s) => { $(s).disabled = off; });
  $("#k-swatches").classList.toggle("disabled", off);
}
async function setSkin(opts) {
  const r = await api.set_alas_skin(opts);
  if (!r.ok) { await alertBox("无法更改换肤", r.message); }
  loadSkin();
  skinAlas();
}
function initSkinControls() {
  const box = $("#k-swatches");
  for (const [c, name] of SKIN_COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "k-swatch";
    b.dataset.c = c;
    b.title = name;
    b.style.setProperty("--c", c);
    b.addEventListener("click", (e) => { e.preventDefault(); setSkin({ accent: c }); });
    box.appendChild(b);
  }
  // 最后一个是自定义颜色(彩虹圈,点开系统取色器)
  const lab = document.createElement("label");
  lab.className = "k-swatch k-custom";
  lab.title = "自定义颜色";
  lab.innerHTML = '<input type="color" id="k-custom">';
  box.appendChild(lab);
  $("#k-custom").addEventListener("change", (e) => setSkin({ accent: e.target.value }));
  $("#k-enabled").addEventListener("change", (e) => setSkin({ enabled: e.target.checked }));
  $("#k-theme").addEventListener("change", (e) => setSkin({ theme: e.target.value }));
  $("#k-radius").addEventListener("change", (e) => setSkin({ radius: +e.target.value }));
  $("#k-bg").addEventListener("change", (e) => setSkin({ bg: e.target.value }));
  $("#k-dim").addEventListener("input", (e) => { $("#k-dim-val").textContent = `${Math.round(e.target.value * 100)}%`; });
  $("#k-dim").addEventListener("change", (e) => setSkin({ dim: +e.target.value }));
  $("#k-open").addEventListener("click", (e) => {
    e.preventDefault();
    closeSheet("settings");
    showView("alas");
  });
}

// ---------- 顶栏“资源 / Alas”:Alas 自己的网页嵌在这个窗口里 ----------
// 面板网页和 Alas 网页经本机代理同源(Python 的 alas_proxy.py),所以能直接给嵌入的页面注入换肤样式。
// 第一次切到 Alas 才加载;之后切回“资源”也不卸载,Alas 页面保持连接,再切过去是原样。
let moveView = null;
let alasFrameLoaded = false;
function showView(v) {
  const alas = v === "alas";
  document.body.classList.toggle("view-alas", alas);
  $("#alas-view").hidden = !alas;
  if (moveView) moveView(v);
  if (alas) ensureAlas(false);
  else render(state.view, true);           // 切回来时图表按当前窗口大小重画
}
async function ensureAlas(force) {
  const frame = $("#alas-frame"), empty = $("#alas-empty");
  let info;
  try { info = await api.alas_embed_info(); } catch (e) { report(e); return; }
  if (!info.running) {
    if (!alasFrameLoaded || force) {
      frame.hidden = true;
      empty.hidden = false;
      $("#alas-empty-title").textContent = info.has_root ? "Alas 没有在运行" : "还没有设置 Alas 文件夹";
      $("#alas-empty-sub").textContent = info.has_root
        ? `打不开 Alas 的网页(127.0.0.1:${info.port})。先启动 AlasApp,再点“重新连接”。`
        : "在 设置 → 连接 里选择 Alas 所在的文件夹。";
    }
    return;
  }
  empty.hidden = true;
  frame.hidden = false;
  if (!alasFrameLoaded || force) {
    alasFrameLoaded = true;
    frame.src = "/?t=" + Date.now();      // 同源地址,代理转发给 Alas
  }
}
async function skinAlas() {
  const frame = $("#alas-frame");
  if (!alasFrameLoaded || !frame.contentWindow) return;
  try {
    const js = await api.alas_skin_js();
    frame.contentWindow.eval(js);
  } catch (e) { report(e); }
}
function initAlasView() {
  moveView = segmented("view-seg", "panel", showView);
  $("#alas-frame").addEventListener("load", skinAlas);      // Alas 页面每次(重新)加载都注入一次
  $("#alas-retry").addEventListener("click", () => ensureAlas(true));
}

// ---------- 浅色 / 深色 ----------
// 写到 <html data-theme>;auto = 不写,跟随系统。桌面面板存进 config.json(页面地址每次启动都变,浏览器存储会丢),
// 远程网页存在浏览器 localStorage。换主题后图表按新颜色重画。
const isDark = () => document.documentElement.dataset.theme === "dark" ||
  (document.documentElement.dataset.theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const btn = $("#btn-theme");
  if (btn) btn.title = (isDark() ? "切换到浅色" : "切换到深色") + "(右键:跟随系统" + (t === "light" || t === "dark" ? "" : ",现在就是") + ")";
  if (state.view) render(state.view, true);
}
function setTheme(t) {
  applyTheme(t);
  if (document.body.classList.contains("remote")) store.set("theme", t);
  else if (api && api.set_ui_theme) api.set_ui_theme(t).catch(report);
}

// 点窗口右上角 × 时,Python 发现正在采样会调用这里
async function askQuit() {
  const yes = await modal("正在采样", "关闭窗口会停止采样。", [
    { label: "取消", value: false }, { label: "停止并关闭", kind: "primary", value: true }]);
  if (yes) api.quit();
}
window.askQuit = askQuit;

// ---------- 悬停提示:按时间查各面板的值 ----------
function buildLookup(v) {
  const L = {};
  for (const key of KEYS) {
    const s = seriesOf(v, key);
    const pts = [];
    if (s.candles) s.candles.forEach((c) => pts.push([c[0], c[2]]));
    else {
      (s.line || []).forEach((p) => { if (p[1] !== "-") pts.push(p); });
      (s.dots || []).forEach((p) => pts.push(p));
    }
    pts.sort((a, b) => a[0] - b[0]);
    const gaps = [];
    const g = s.gaps || [];
    for (let i = 0; i + 1 < g.length; i += 3) gaps.push([g[i][0], g[i][1], g[i + 1][0], g[i + 1][1]]);
    L[key] = { xs: pts.map((p) => p[0]), ys: pts.map((p) => p[1]), gaps, s };
  }
  return L;
}
function bisectRight(xs, x) {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}
function tooltipHtml(params) {
  const v = state.view;
  if (!v || !params.length) return "";
  const t = params[0].axisValue;
  const L = state.lookup;
  let html = `<div style="font-weight:600;margin-bottom:6px">${fmtTime(t, true)} <span style="font-weight:400;color:${css("--ink-3")}">北京时间</span>` +
             (localDiffers(t) ? `<div style="font-weight:400;font-size:11px;color:${css("--ink-3")}">你那里 ${localHM(t)}</div>` : "") + `</div>`;
  for (const key of KEYS) {
    const { xs, ys, gaps, s } = L[key];
    const dk = dataKey(v, key);                // 第三栏选了魔方时这一行显示魔方
    const color = css(`--${dk}`);
    let text;
    if (s.candles && s.candles.length) {
      const half = s.candles.length > 1 ? (s.candles[1][0] - s.candles[0][0]) / 2 : 1e12;
      let best = null;
      for (const c of s.candles) if (Math.abs(c[0] - t) <= half) { best = c; break; }
      if (best) {
        const up = best[2] >= best[1];
        text = `开 ${num(best[1])} · 高 ${num(best[4])} · 低 ${num(best[3])} · 收 <b style="color:${up ? css("--up") : css("--down")}">${num(best[2])}</b>`;
        const mas = Object.entries(s.ma || {}).map(([n, arr], i) => {
          const p = arr.find((q) => q[0] === best[0]);
          return p ? `<span style="color:${css(`--ma${i + 1}`)}">MA${n} ${num(p[1])}</span>` : "";
        }).filter(Boolean).join(" · ");
        if (mas) text += `<div style="margin:2px 0 0 15px;font-size:11px">${mas}</div>`;
      } else text = `<span style="color:${css("--ink-3")}">这段时间没有 K 线</span>`;
    } else {
      const gap = gaps.find((g) => t > g[0] && t < g[2]);
      const i = bisectRight(xs, t) - 1;
      if (gap) text = `<span style="color:${css("--ink-3")}">无读数(${fmtValue(dk, gap[1])} → ${fmtValue(dk, gap[3])})</span>`;
      else if (i < 0) text = `<span style="color:${css("--ink-3")}">—</span>`;
      else text = `<b>${fmtValue(dk, ys[i])}</b>`;
    }
    html += `<div style="display:flex;gap:8px;align-items:baseline;line-height:1.7">
      <span style="width:7px;height:7px;border-radius:50%;background:${color};display:inline-block;flex:none;transform:translateY(-1px)"></span>
      <span style="color:${css("--ink-2")};flex:none">${NAMES[dk]}</span><span>${text}</span></div>`;
  }
  return html;
}

// ---------- 图表 ----------
function layout(H, effMode) {
  const tight = H < 420;            // 图表比较矮时(小窗口),面板之间的空隙收紧
  // 上边距要放得下第一栏标题前 22 像素高的图标(以前只有 30,金币图标顶上被画布切掉了一条)
  const top = tight ? 32 : 36, gap = tight ? 36 : 46, bottom = 28;
  // 散点模式:石油那一栏下面要显示时间刻度,和第三栏之间多留一点
  const extra = effMode ? 20 : 0;
  const avail = Math.max(H - top - bottom - gap * 2 - extra, 150);
  const sum = KEYS.reduce((a, k) => a + RATIO[k], 0);
  let y = top;
  return KEYS.map((k, i) => {
    const h = avail * RATIO[k] / sum;
    const g = { top: y, height: h };
    y += h + gap + (i === 1 ? extra : 0);
    return g;
  });
}
function yRange(key, s) {
  if (s.min === undefined) return {};
  const span = s.max - s.min;
  const padding = span ? span * 0.12 : (key === "exp" ? 0.02 : Math.max(Math.abs(s.max) * 0.002, 5));
  return { min: s.min - padding, max: s.max + padding };
}

// 第三栏标题:“等级进度 | 经验 vs 油耗 | 魔方”三个可点的选项(当前的加粗)
function thirdTabs(option, g, left, C, color) {
  const cur = thirdMode();
  const dot = cur === "eff" ? css("--oil") : cur === "cube" ? css("--cube") : color;
  option.graphic.push({ type: "circle", left: left + 1, top: g.top - 21, shape: { r: 4.5 },
                        style: { fill: dot }, silent: true });
  let x = left + 16;
  const tabs = [["exp", "等级进度"], ["eff", "经验 vs 油耗"], ["cube", "魔方"]].filter(([v]) => !(v === "eff" && isRemote()));
  tabs.forEach(([v, label], i) => {
    const on = v === cur;
    if (i) {
      option.graphic.push({ type: "text", left: x, top: g.top - 25, style: { text: "|", fill: C.ink3, fontSize: 13 }, silent: true });
      x += 14;
    }
    option.graphic.push({
      type: "text", left: x, top: g.top - 26, cursor: "pointer",
      style: { text: label, fill: on ? C.ink : C.ink3, fontSize: 14, fontWeight: on ? 600 : 400 },
      onclick: () => { if (!on) setThird(v); },
    });
    x += textWidth(label, 14, on ? 600 : 400) + 10;      // 按实际字宽排,中英文混排也对得齐
  });
}
let measureCtx = null;
function textWidth(text, size, weight) {
  measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
  measureCtx.font = `${weight} ${size}px ${getComputedStyle(document.body).fontFamily}`;
  return Math.ceil(measureCtx.measureText(text).width);
}

// 经验 vs 油耗:第三栏换成散点(x 石油花费,y 经验),不跟上面两栏的时间轴联动
function applyEff(option, e, g, C, left, right, W) {
  const oil = css("--oil"), up = css("--up-ink") || css("--up");
  option.xAxis[2] = {      // 横轴 = 石油花费,纵轴 = 经验(标题“经验 vs 油耗”已经说明,不另写轴名,免得和刻度挤在一起)
    type: "value", gridIndex: 2, min: 0,
    axisLine: { lineStyle: { color: C.hair } }, axisTick: { show: false },
    axisLabel: { color: C.ink3, fontSize: 11, hideOverlap: true, formatter: (x) => num(x) },
    splitLine: { show: true, lineStyle: { color: C.grid } }, axisPointer: { show: false },
  };
  option.yAxis[2] = {
    type: "value", gridIndex: 2, position: "right", min: 0, splitNumber: 2,
    axisLabel: { color: C.ink3, fontSize: 11, margin: 12, formatter: (y) => (y >= 10000 ? `${+(y / 10000).toFixed(1)}万` : num(y)) },
    splitLine: { lineStyle: { color: C.grid } }, axisLine: { show: false }, axisTick: { show: false }, axisPointer: { show: false },
  };
  option.dataZoom[0].xAxisIndex = [0, 1];
  option.xAxis[1].axisLabel.show = true;          // 时间刻度挪到石油那一栏下面
  option.axisPointer = { link: [{ xAxisIndex: [0, 1] }] };
  option.grid[2].tooltip = {
    trigger: "item", confine: true, backgroundColor: option.tooltip.backgroundColor, borderColor: C.hair, borderWidth: 1,
    padding: [10, 14], textStyle: { color: C.ink, fontSize: 12 }, extraCssText: option.tooltip.extraCssText,
    formatter: (p) => {
      const d = p.data && p.data.raw;
      if (!d) return "";
      const span = e.hours >= 24 ? fmtTime(d.start).slice(0, 5) : `${fmtTime(d.start)}–${hhmm(d.end)}`;
      const ratio = d.exp > 0 ? `每 1 万经验 ${num(Math.round(d.oil / d.exp * 10000))} 油` : "没有涨经验";
      return `<b>${span}</b>${d.partial ? "(还没结束)" : ""}<br>石油花费 <b>${num(d.oil)}</b> · 经验 <b>+${num(d.exp)}</b><br>${ratio}`;
    },
  };
  const pts = e.points;
  const n = pts.length;
  option.series.push({
    type: "scatter", xAxisIndex: 2, yAxisIndex: 2, z: 4,
    data: pts.map((p, i) => ({
      value: [p.oil, p.exp], raw: p,
      // 越新的点越不透明,最新的一个描边
      itemStyle: { color: oil, opacity: n > 1 ? 0.35 + 0.65 * i / (n - 1) : 1,
                   borderColor: i === n - 1 ? C.ink : "transparent", borderWidth: i === n - 1 ? 1.5 : 0 },
    })),
    symbolSize: e.hours >= 24 ? 11 : e.hours >= 6 ? 9 : 7, emphasis: { scale: 1.4 },
  });
  // 平均效率:过原点的虚线,斜率 = 这段时间总经验 / 总油耗
  if (e.oil > 0 && e.exp > 0) {
    const maxX = Math.max(...pts.map((p) => p.oil)) * 1.08;
    option.series.push({
      type: "line", xAxisIndex: 2, yAxisIndex: 2, data: [[0, 0], [maxX, maxX * e.exp / e.oil]], showSymbol: false,
      lineStyle: { color: C.ink3, width: 1, type: [5, 4] }, silent: true, z: 2,
    });
    // 平均值写在标题行(两个选项后面),不放在图里
    option.graphic.push({ type: "text", left: left + 16 + textWidth("等级进度经验 vs 油耗魔方", 14, 600) + 70, top: g.top - 23, silent: true,
                          style: { text: `虚线 = 平均 每万经验 ${num(Math.round(e.oil / e.exp * 10000))} 油 · 线上方的点更省油`,
                                   fill: C.ink3, fontSize: 12 } });
  }
  // 右上角:每个点代表多久
  const opts = [[1, "按小时"], [6, "按 6 小时"], [24, "按天"]];
  let x = right;
  opts.slice().reverse().forEach(([h, label]) => {
    const on = h === e.hours;
    option.graphic.push({ type: "text", right: x, top: g.top - 24, cursor: "pointer",
                          style: { text: label, fill: on ? C.ink : C.ink3, fontSize: 12, fontWeight: on ? 600 : 400 },
                          onclick: () => { if (!on) setEffHours(h); } });
    x += label.length * 12 + 14;
  });
  if (!n) {
    option.graphic.push({ type: "text", left: left + (W - left - right) / 2 - 120, top: g.top + g.height / 2 - 8,
                          style: { text: "这段时间没有足够的经验记录和石油读数", fill: C.ink3, fontSize: 13 }, silent: true });
  }
}

function render(v, quiet) {
  if (!v) return;
  const el = $("#chart");
  const W = el.clientWidth, H = el.clientHeight;
  const grids = layout(H, thirdMode() === "eff" && !!v.eff);
  const C = {
    surface: css("--surface"), ink: css("--ink"), ink2: css("--ink-2"), ink3: css("--ink-3"),
    grid: css("--grid"), hair: css("--hair"), up: css("--up"), down: css("--down"),
  };
  const left = 14, right = 70;
  const [w0, w1] = v.window;
  const option = {
    animation: !quiet, animationDuration: 900, animationEasing: "cubicOut", animationDurationUpdate: 500,
    textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
    grid: grids.map((g) => ({ left, right, top: g.top, height: g.height })),
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    xAxis: KEYS.map((k, i) => ({
      type: "time", gridIndex: i, min: w0, max: w1,
      axisLine: { lineStyle: { color: C.hair } }, axisTick: { show: false },
      axisLabel: {
        show: i === KEYS.length - 1, color: C.ink3, fontSize: 11, hideOverlap: true, margin: 10,
        // 刻度文字按北京时间写(ECharts 自带的格式按看网页那台设备的时区,远程网页在国外会对不上)
        formatter: (v) => {
          const d = bj(v), span = w1 - w0;
          if (span > 120 * 864e5) return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
          if (span > 2 * 864e5 || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0)) return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
          return hhmm(v);
        },
      },
      splitLine: { show: true, lineStyle: { color: C.grid } },
      axisPointer: { label: { show: false } },
    })),
    yAxis: KEYS.map((k, i) => ({
      type: "value", gridIndex: i, position: "right", splitNumber: k === "exp" ? 2 : 3,
      ...yRange(dataKey(v, k), seriesOf(v, k)),
      // 上下边界是按数据留白算的,不是整数,不显示它们的刻度
      axisLabel: { color: C.ink3, fontSize: 11, formatter: axisLabel(dataKey(v, k)), margin: 12,
                   showMinLabel: false, showMaxLabel: false },
      splitLine: { lineStyle: { color: C.grid } }, axisLine: { show: false }, axisTick: { show: false },
    })),
    tooltip: {
      trigger: "axis", confine: true, transitionDuration: 0.12,
      axisPointer: { type: "line", lineStyle: { color: C.ink3, width: 1 }, animation: false },
      backgroundColor: rgba(C.surface, 0.86), borderColor: C.hair, borderWidth: 1, padding: [10, 14],
      textStyle: { color: C.ink, fontSize: 12 },
      extraCssText: "backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);" +
                    "border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.14);",
      formatter: tooltipHtml,
    },
    // 触屏(手机)上单指拖动留给页面滚动,双指捏合缩放图表
    dataZoom: [{ type: "inside", xAxisIndex: KEYS.map((_, i) => i), filterMode: "none",
                 zoomOnMouseWheel: true, moveOnMouseMove: !TOUCH, moveOnTouch: !TOUCH, minValueSpan: 5 * 60000 }],
    graphic: [],
    series: [],
  };
  const eff = thirdMode() === "eff" && v.eff;
  if (eff) applyEff(option, v.eff, grids[2], C, left, right, W);
  let anyGap = false;
  KEYS.forEach((key, i) => {
    const s = seriesOf(v, key);
    const color = css(`--${dataKey(v, key)}`);
    const g = grids[i];
    if (key === "exp") {
      thirdTabs(option, g, left, C, color);         // 第三栏的标题换成可点的选项
      if (eff) return;
    }
    // 面板名(左上角)+ K 线模式下各条均线的最新值
    const rich = { name: { fontSize: 14, fontWeight: 600, fill: C.ink } };
    let text = `{name|${NAMES[key]}}`;
    if (s.ma) {
      Object.entries(s.ma).forEach(([n, arr], j) => {
        rich["m" + j] = { fontSize: 11, fill: css(`--ma${j + 1}`), padding: [0, 0, 0, 12] };
        text += `{m${j}|MA${n} ${arr.length ? num(arr[arr.length - 1][1]) : "—"}}`;
      });
    }
    if (key !== "exp") {
      const icon = state.icons && state.icons[key];        // 物资、石油:标题前用游戏图标代替圆点
      if (icon) {
        // 和标题文字(top = g.top - 26,14 号字)垂直居中
        option.graphic.push({ type: "image", left: left - 2, top: g.top - 29, style: { image: icon, width: 22, height: 22 }, silent: true });
      } else {
        option.graphic.push({ type: "circle", left: left + 1, top: g.top - 21, shape: { r: 4.5 }, style: { fill: color }, silent: true });
      }
      option.graphic.push({ type: "text", left: left + (icon ? 25 : 16), top: g.top - 26, style: { text, rich, fill: C.ink }, silent: true });
    }
    if (!s.count) {
      option.graphic.push({ type: "text", left: left + (W - left - right) / 2 - 50, top: g.top + g.height / 2 - 8,
                            style: { text: "这段时间没有读数", fill: C.ink3, fontSize: 13 }, silent: true });
      return;
    }
    if (s.candles) {
      // K 线:涨 = 红色空心,跌 = 绿色实心(和旧界面一致)
      const xs = s.candles.map((c) => c[0]);
      let step = Infinity;
      for (let j = 1; j < xs.length; j++) step = Math.min(step, xs[j] - xs[j - 1]);
      if (!isFinite(step)) step = (w1 - w0) / 20;
      const barW = Math.max(1, Math.min(18, (W - left - right) * step / (w1 - w0) * 0.62));
      option.series.push({
        type: "candlestick", xAxisIndex: i, yAxisIndex: i, barWidth: barW,
        data: s.candles.map((c) => [c[0], c[1], c[2], c[3], c[4]]), encode: { x: 0, y: [1, 2, 3, 4] },
        itemStyle: { color: C.surface, color0: C.down, borderColor: C.up, borderColor0: C.down, borderWidth: 1.2 },
        emphasis: { disabled: true },
      });
      Object.entries(s.ma || {}).forEach(([n, arr], j) => option.series.push({
        type: "line", xAxisIndex: i, yAxisIndex: i, data: arr, showSymbol: false, smooth: 0.3,
        lineStyle: { width: 1.5, color: css(`--ma${j + 1}`) }, emphasis: { disabled: true }, z: 4,
      }));
      return;
    }
    const exp = key === "exp";                  // 第三栏(等级进度或魔方):几小时一个点,画出圆点
    option.series.push({
      type: "line", xAxisIndex: i, yAxisIndex: i, data: s.line, connectNulls: false,
      showSymbol: exp, symbol: "circle", symbolSize: 7,
      lineStyle: { width: 2, color, cap: "round", join: "round" },
      itemStyle: { color, borderColor: C.surface, borderWidth: 2 },
      areaStyle: exp ? undefined : {
        origin: "start",
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: rgba(color, 0.22) }, { offset: 1, color: rgba(color, 0) }]),
      },
      emphasis: { disabled: true }, z: 3,
    });
    if (s.gaps && s.gaps.length) {
      anyGap = true;
      option.series.push({
        type: "line", xAxisIndex: i, yAxisIndex: i, data: s.gaps, connectNulls: false, showSymbol: false,
        lineStyle: { width: 1.5, color, type: [4, 4], opacity: 0.5 }, silent: true, emphasis: { disabled: true }, z: 2,
      });
    }
    if (s.dots && s.dots.length) {
      option.series.push({ type: "scatter", xAxisIndex: i, yAxisIndex: i, data: s.dots, symbolSize: 5,
                           itemStyle: { color }, silent: true, z: 3 });
    }
    // 最新读数:带呼吸光圈的圆点(最近 10 分钟内有读数时)
    if (s.last_time && v.now - s.last_time < 10 * 60000 && s.last_time >= w0 && s.last_time <= w1) {
      option.series.push({
        type: "effectScatter", xAxisIndex: i, yAxisIndex: i, data: [[s.last_time, s.last]],
        symbolSize: 8, itemStyle: { color, borderColor: C.surface, borderWidth: 2 },
        rippleEffect: { scale: 3, brushType: "fill", period: 3 }, silent: true, z: 5,
      });
    }
  });

  ignoreZoom = true;
  chart.setOption(option, { notMerge: true });
  ignoreZoom = false;
  state.lookup = buildLookup(v);

  // 底部说明
  let text = state.zoom ? `所选范围 ${fmtTime(w0)} – ${fmtTime(w1)} · 双击还原`
                        : `${fmtTime(w0)} – ${state.range === "all" ? fmtTime(w1) : "现在"}`;
  if (v.mode === "candle") text += ` · 每根 K 线 ${v.period}${v.period_note ? "(" + v.period_note + ")" : ""}`;
  $("#range-text").textContent = text + " · 北京时间";
  $(".legend-gap").classList.toggle("show", anyGap);
}

// ---------- 取数据 ----------
async function load(quiet) {
  if (busy) { pending = true; return; }
  busy = true;
  try {
    const opts = { range: state.range, mode: state.mode, period: state.period, ma: maList(),
                   third: thirdMode(), eff_hours: state.effHours };
    if (state.zoom) { opts.start = state.zoom[0]; opts.end = state.zoom[1]; }
    const v = await api.get_view(opts);
    state.view = v;
    render(v, quiet && !state.first);
    renderTiles(v);
    state.first = false;
  } catch (e) {
    report(e);
  } finally {
    busy = false;
    if (pending) { pending = false; load(false); }
  }
}

function onZoom() {
  if (ignoreZoom || !state.view) return;
  state.lastInteract = Date.now();
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    const dz = chart.getOption().dataZoom[0];
    const [w0, w1] = state.view.window;
    const s = dz.startValue !== undefined ? dz.startValue : w0 + (w1 - w0) * dz.start / 100;
    const e = dz.endValue !== undefined ? dz.endValue : w0 + (w1 - w0) * dz.end / 100;
    if (Math.abs(s - w0) < 1000 && Math.abs(e - w1) < 1000) return;
    state.zoom = [Math.round(s), Math.round(e)];
    moveRange(null);
    load(true);
  }, 450);
}

function init() {
  chart = echarts.init($("#chart"), null, { renderer: "canvas" });
  chart.on("datazoom", onZoom);
  chart.getZr().on("dblclick", () => {
    if (!state.zoom) return;
    state.zoom = null;
    moveRange(state.range);
    load(false);
  });

  moveRange = segmented("seg-range", state.range, (v) => {
    state.range = v; state.zoom = null; store.set("range", v); load(false);
  });
  moveMode = segmented("seg-mode", state.mode, (v) => {
    state.mode = v; store.set("mode", v);
    $("#candle-opts").classList.toggle("show", v === "candle");
    load(false);
  });
  $("#candle-opts").classList.toggle("show", state.mode === "candle");
  const period = $("#period"), ma = $("#ma");
  period.value = state.period;
  ma.value = state.ma;
  period.addEventListener("change", () => { state.period = period.value; store.set("period", state.period); load(false); });
  const applyMa = () => {
    state.ma = ma.value;
    state.ma = ma.value = maList().join(",");     // 规范化(去掉写错的部分)
    store.set("ma", state.ma);
    load(false);
  };
  ma.addEventListener("change", applyMa);
  ma.addEventListener("keydown", (e) => { if (e.key === "Enter") ma.blur(); });

  // 进场动画:标题、卡片、图表依次淡入
  document.querySelectorAll(".reveal").forEach((el, i) => {
    el.style.transitionDelay = `${i * 90}ms`;
    requestAnimationFrame(() => el.classList.add("in"));
    setTimeout(() => { el.style.transitionDelay = ""; }, 1200 + i * 90);
  });

  // 图表区域大小一变(拉窗口、切 K 线时工具栏换行等)就重排图表
  let resizeTimer = null;
  const relayout = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      chart.resize();
      render(state.view, true);
      moveRange(state.zoom ? null : state.range, false);
      moveMode(state.mode, false);
      if (moveSideTab) moveSideTab(store.get("sidetab", "alas"), false);
    }, 80);
  };
  if (window.ResizeObserver) new ResizeObserver(relayout).observe($("#chart"));
  window.addEventListener("resize", relayout);
  if (document.fonts) document.fonts.ready.then(() => {
    moveRange(state.zoom ? null : state.range, false);
    moveMode(state.mode, false);
    if (moveSideTab) moveSideTab(store.get("sidetab", "alas"), false);
  });
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  if (dark.addEventListener) dark.addEventListener("change", () => render(state.view, true));
  // 顶栏浅色/深色按钮:点一下在浅色、深色之间切换,右键恢复跟随系统
  if (document.body.classList.contains("remote")) applyTheme(store.get("theme", "auto"));   // 远程网页记在浏览器里
  $("#btn-theme").addEventListener("click", () => setTheme(isDark() ? "light" : "dark"));
  $("#btn-theme").addEventListener("contextmenu", (e) => { e.preventDefault(); setTheme("auto"); });

  $("#btn-start").addEventListener("click", onStart);
  $("#btn-test").addEventListener("click", onTest);
  initPanels();

  load(false);
  pollService();
  setInterval(pollService, 1000);
  if (!document.body.classList.contains("remote")) {
    initBackgroundControls();
    initSkinControls();
    initAlasView();
    loadBackground();
    pollAlas();
    setInterval(pollAlas, 10000);      // 每 10 秒读一次 Alas 日志和配置
    setInterval(renderAlas, 15000);    // 倒计时在两次读取之间也走
  } else {
    setInterval(renderAlas, 15000);    // 远程网页:Alas 状态随数据更新,倒计时照样走
  }
  // 定时刷新(别的程序在写数据时也能看到变化);用户刚缩放/拖动过就先不刷,免得打断
  setInterval(() => { if (Date.now() - state.lastInteract > 5000) load(true); }, REFRESH_MS);
}

async function start() {
  if (api) return;
  api = window.pywebview.api;
  try {   // 启动参数 --theme 或顶栏按钮选的浅色/深色,没选就跟随系统
    const cfg = await api.ui_config();
    applyTheme(cfg && cfg.theme);
  } catch (e) { report(e); }
  init();
}
if (window.pywebview && window.pywebview.api && window.pywebview.api.get_view) start();
else window.addEventListener("pywebviewready", start);
