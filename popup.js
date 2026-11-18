// 弹窗内禁用原生右键菜单；网页里的右键菜单是本扩展的功能入口，不受影响
document.addEventListener("contextmenu", (event) => event.preventDefault());

const collator = new Intl.Collator("zh-Hans-CN-u-co-pinyin", { sensitivity: "base", numeric: true });
const isManageable = (ext) => ext.type === "extension" && ext.mayDisable !== false && ext.id !== chrome.runtime.id;

const listEl = document.getElementById("list");
const countEl = document.getElementById("count");
const enableEl = document.getElementById("enableAll");
const killEl = document.getElementById("disableAll");

// 由名称稳定派生徽章色，同一扩展每次打开颜色一致
const badgeHue = (name) => {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${hash} 48% 42%)`;
};

// 静态图标常量（不含任何外部数据，可安全用作 innerHTML）
const TRASH_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3.3c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.2M4.7 4.5l.5 7.5c0 .6.4 1 1 1h3.6c.6 0 1-.4 1-1l.5-7.5"/></svg>';

function makeItem(ext) {
  const row = document.createElement("div");
  row.className = `item${ext.enabled ? " on" : ""}`;
  row.ext = ext; // 供点击回调与增量刷新读取最新状态

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = [...ext.name][0] || "?";
  badge.style.background = badgeHue(ext.name);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = ext.name;

  const knob = document.createElement("span");
  knob.className = "switch";
  knob.appendChild(document.createElement("i"));

  const hit = document.createElement("button");
  hit.className = "hit";
  hit.append(badge, name, knob);
  hit.addEventListener("click", () => toggle(row.ext, !row.ext.enabled));

  const trash = document.createElement("button");
  trash.className = "uninstall";
  trash.title = `卸载 ${ext.name}`;
  trash.setAttribute("aria-label", `卸载 ${ext.name}`);
  trash.innerHTML = TRASH_ICON;
  trash.addEventListener("click", () => uninstall(ext));

  row.append(hit, trash);
  return row;
}

const rowCache = new Map(); // id -> 行节点，状态变化时复用而不是重建 DOM

function render(exts) {
  // 按拼音/字母固定排序：切换开关只改状态，不改变列表位置
  const list = exts
    .filter(isManageable)
    .sort((a, b) => collator.compare(a.name, b.name));
  const enabled = list.filter((e) => e.enabled).length;
  countEl.textContent = list.length ? `${enabled} / ${list.length} 已启用` : "无扩展";
  killEl.disabled = enabled === 0;
  enableEl.disabled = list.length === 0 || enabled === list.length;

  if (!list.length) {
    rowCache.clear();
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "🍃 没有可管理的扩展";
    listEl.replaceChildren(empty);
    return;
  }

  const alive = new Set(list.map((e) => e.id));
  for (const id of rowCache.keys()) if (!alive.has(id)) rowCache.delete(id);

  listEl.replaceChildren(...list.map((ext) => {
    const cached = rowCache.get(ext.id);
    if (cached) {
      cached.ext = ext;
      cached.classList.toggle("on", ext.enabled);
      return cached;
    }
    const row = makeItem(ext);
    rowCache.set(ext.id, row);
    return row;
  }));
}

// 事件风暴合并：批量开关时只重绘一次
let loadTimer = null;
function load(delay = 60) {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    chrome.management.getAll((exts) => {
      if (chrome.runtime.lastError || !exts) return;
      render(exts);
      renderMissing(exts);
    });
  }, delay);
}

// 本地记忆（与云端同步后一致）中记录、但当前浏览器没装的扩展：列出来并提供商店页入口
// （Chrome 不允许扩展静默安装其他扩展，只能一键跳转由用户确认安装）
const STORE_DETAIL = "https://chromewebstore.google.com/detail/";
const missingEl = document.getElementById("missing");
const missingCountEl = document.getElementById("missingCount");
const missingListEl = document.getElementById("missingList");

// 基准快照直接读本地记忆（与云端同步后一致），缺失列表本身不额外发网络请求
let presetPromise = null;
function getPreset() {
  if (!presetPromise) {
    presetPromise = new Promise((resolve) =>
      chrome.storage.local.get(MEMORY_KEY, (d) => resolve((d && d[MEMORY_KEY]) || {}))
    );
  }
  return presetPromise;
}

let missingIds = [];

// 受 Chrome 策略限制，扩展无法静默安装其他扩展；
// 这里用独立窗口一次性打开全部商店页，逐个点「添加至 Chrome」即可
document.getElementById("installAll").addEventListener("click", () => {
  if (missingIds.length) chrome.windows.create({ url: missingIds.map((id) => STORE_DETAIL + id) });
});

let lastExts = [];
const ignoredMissing = new Set(); // 本次面板会话内已忽略的幽灵记录

// 忽略该 ID：写墓碑（带新 ts）而非直接删除，让“不再提示”能同步到云端与其它设备
function ignoreMissing(id) {
  ignoredMissing.add(id);
  chrome.storage.local.get(MEMORY_KEY, (data) => {
    const mem = { ...((data && data[MEMORY_KEY]) || {}) };
    if (mem[id] && !mem[id].deleted) mem[id] = { ...mem[id], deleted: true, ts: Date.now() };
    presetPromise = null;
    chrome.storage.local.set({ [MEMORY_KEY]: mem }, () => renderMissing(lastExts));
  });
}

async function renderMissing(exts) {
  lastExts = exts;
  const preset = await getPreset();
  const have = new Set(exts.map((e) => e.id));
  const haveNames = new Set(exts.map((e) => e.name));
  // 按 ID 或名称双匹配：扩展换 ID 重装（解包/不同来源）后，旧记录不再误报为未安装
  const missing = Object.entries(preset || {}).filter(([id, info]) =>
    !have.has(id) && !haveNames.has(info?.name) && !ignoredMissing.has(id) && !info?.deleted);
  missingIds = missing.map(([id]) => id);
  missingEl.hidden = missingIds.length === 0;
  if (!missingIds.length) return;

  missingCountEl.textContent = `${missing.length} 个扩展未安装`;
  missingListEl.replaceChildren(...missing.map(([id, info]) => {
    const row = document.createElement("div");
    row.className = "missing-item";

    const name = document.createElement("span");
    name.className = "missing-name";
    name.textContent = (info && info.name) || id;
    name.title = id;

    const install = document.createElement("button");
    install.className = "missing-act";
    install.textContent = "安装 ↗";
    install.title = `在应用商店打开 ${id}`;
    install.addEventListener("click", () => chrome.tabs.create({ url: STORE_DETAIL + id }));

    const ignore = document.createElement("button");
    ignore.className = "missing-act ignore";
    ignore.textContent = "忽略";
    ignore.title = "从记录中移除该扩展，不再提示";
    ignore.addEventListener("click", () => ignoreMissing(id));

    row.append(name, install, ignore);
    return row;
  }));
}

// 后台持续播放开关：只写 storage，注册/注销由 background 统一负责
const KEEP_ALIVE_KEY = "keepAlive";
const keepEl = document.getElementById("keepAlive");
const paintKeepAlive = (on) => keepEl.classList.toggle("on", on);

keepEl.addEventListener("click", () => {
  const next = !keepEl.classList.contains("on");
  paintKeepAlive(next);
  chrome.storage.local.set({ [KEEP_ALIVE_KEY]: next });
});

// 默认开启：仅显式写入 false 时才视为关闭
const isKeepAliveOn = (data) => !data || data[KEEP_ALIVE_KEY] !== false;
chrome.storage.local.get(KEEP_ALIVE_KEY, (data) => paintKeepAlive(isKeepAliveOn(data)));

// 启用扩展时 Chrome 可能弹确认框，用户取消属正常操作，不刷告警
const isUserCancel = (message) => /did not accept/i.test(message || "");

// 点击扩展项切换启用状态；以浏览器实际状态为准重绘
function toggle(ext, enabled) {
  chrome.management.setEnabled(ext.id, enabled, () => {
    const err = chrome.runtime.lastError;
    if (err && !isUserCancel(err.message)) console.warn(`setEnabled ${ext.name}:`, err.message);
    load();
  });
}

// 卸载：交给浏览器原生确认框，用户取消时仅为 lastError，不做任何处理
function uninstall(ext) {
  chrome.management.uninstall(ext.id, { showConfirmDialog: true }, () => {
    const err = chrome.runtime.lastError;
    if (err) return;
    load();
  });
}

// 批量开关：只处理状态需要变化的扩展
function setAll(enabled) {
  chrome.management.getAll((exts) => {
    const targets = (exts || []).filter((e) => isManageable(e) && e.enabled !== enabled);
    if (!targets.length) return load();
    let remaining = targets.length;
    for (const ext of targets) {
      chrome.management.setEnabled(ext.id, enabled, () => {
        const err = chrome.runtime.lastError;
        if (err && !isUserCancel(err.message)) console.warn(`setEnabled ${ext.name}:`, err.message);
        if (--remaining === 0) load();
      });
    }
  });
}

enableEl.addEventListener("click", () => setAll(true));
killEl.addEventListener("click", () => setAll(false));

// 状态快照键（background 监听变化后会自动套用到各扩展）
const MEMORY_KEY = "stateMemory";

// 云端同步：地址/token 由 worker/mima.txt 提供，数据走 Worker（GET/PUT /state）
const CLOUD_KEY = "cloudConfig";
let cloudCfg = null;

// 自动读取扩展包内 worker/mima.txt 的 Token/URL 登录，读取失败时回退本地配置
async function readMima() {
  try {
    const res = await fetch(chrome.runtime.getURL("worker/mima.txt"));
    if (!res.ok) return null;
    const text = await res.text();
    const token = text.match(/Token[：:]\s*(\S+)/i)?.[1];
    const host = text.match(/URL[：:]\s*(\S+)/i)?.[1];
    if (!token || !host) return null;
    return { url: /^https?:\/\//.test(host) ? host : `https://${host}`, token };
  } catch { return null; }
}

(async () => {
  cloudCfg = (await readMima()) || await new Promise(res =>
    chrome.storage.local.get(CLOUD_KEY, (d) => res((d && d[CLOUD_KEY]) || {}))
  );
  if (cloudCfg.url && cloudCfg.token) {
    chrome.storage.local.set({ [CLOUD_KEY]: cloudCfg });
    syncNow(); // 打开面板即自动同步一次
  } else {
    cloudStatus("off");
  }
})();

const cloudBtn = document.getElementById("cloudToggle");
const cloudLabel = document.getElementById("cloudStatus");
const CLOUD_LABELS = { on: "已登录", err: "同步失败", off: "未登录" };
function cloudStatus(state) {
  cloudBtn.classList.toggle("on", state === "on");
  cloudBtn.classList.toggle("err", state === "err");
  cloudBtn.title = state === "on" ? "云端已登录" : state === "err" ? "云端登录失败" : "云端未登录";
  cloudLabel.textContent = CLOUD_LABELS[state] || CLOUD_LABELS.off;
  cloudLabel.className = state;
}
async function cloudRequest(method, body) {
  const url = (cloudCfg?.url || "").replace(/\/+$/, "");
  const token = cloudCfg?.token || "";
  if (!/^https?:\/\//.test(url) || !token) return null;
  try {
    const res = await fetch(`${url}/state`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

const readMemory = () =>
  new Promise((resolve) => chrome.storage.local.get(MEMORY_KEY, (d) => resolve((d && d[MEMORY_KEY]) || {})));
const writeMemory = (mem) => new Promise((resolve) => chrome.storage.local.set({ [MEMORY_KEY]: mem }, resolve));

// 逐条按 ts 取新合并（与 background 同语义）；墓碑带 ts，故删除可跨设备传播
function mergeMemory(base, incoming) {
  for (const [id, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== "object") continue;
    const cur = base[id];
    if (!cur || (entry.ts || 0) >= (cur.ts || 0)) base[id] = entry;
  }
  return base;
}

// 拉取并合并；background 监听到 storage 变化后会自动套用状态
async function pullMerge() {
  const remote = await cloudRequest("GET");
  if (!remote || typeof remote !== "object" || Array.isArray(remote) || !Object.keys(remote).length) return 0;
  const local = await readMemory();
  const merged = mergeMemory({ ...local }, remote); // 本地为基 + 云端较新者覆盖，删除墓碑不会被复活
  presetPromise = Promise.resolve(merged); // 基准取合并结果，与实际落盘快照一致
  await writeMemory(merged);
  return Object.keys(remote).length;
}

async function pushState() {
  return (await cloudRequest("PUT", JSON.stringify(await readMemory()))) !== null;
}

// 一次完整同步：拉取合并 → 上传回写 → 重绘；非强制时一分钟内不重复自动同步
async function syncNow(force = false) {
  if (!cloudCfg || !/^https?:\/\//.test(cloudCfg.url || "") || !cloudCfg.token) return cloudStatus("off");
  if (!force) {
    const d = await new Promise((resolve) =>
      chrome.storage.local.get(["lastCloudSync", "lastCloudOk"], resolve)
    );
    // 节流窗口内不重复请求，但仍据上次同步结果恢复图标状态
    if (Date.now() - (d?.lastCloudSync || 0) < 60000) return cloudStatus(d?.lastCloudOk === false ? "err" : "on");
  }
  await pullMerge();
  const ok = await pushState();
  chrome.storage.local.set({ lastCloudSync: Date.now(), lastCloudOk: ok });
  load(0);
  cloudStatus(ok ? "on" : "err");
}

// popup 存活期间跟随浏览器状态（别处切换、安装、卸载都会及时反映）
for (const event of [
  chrome.management.onEnabled,
  chrome.management.onDisabled,
  chrome.management.onInstalled,
  chrome.management.onUninstalled
]) {
  event.addListener(() => load());
}

load(0);
