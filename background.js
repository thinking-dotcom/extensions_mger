/**
 * CORE - 扩展管家（Service Worker）
 */
const DEBUG = false;
// 惰性求值：DEBUG 关闭时不执行传入的取值函数，避免每次全量刷新都白白构造调试数组
const debugLog = (...args) => {
  if (!DEBUG) return;
  console.log("[管理扩展]", ...args.map((a) => (typeof a === "function" ? a() : a)));
};

let isRefreshing = false;
let pendingRefresh = false;
let refreshRetryCount = 0;
let refreshGeneration = 0; // 全量刷新轮次代号：新一轮开始后，旧轮次的迟到回调全部作废
let abandonedSeriesCount = 0; // 连续被放弃的重试系列数：成功刷新或事件触发的新刷新时清零
const MAX_RETRIES = 3; // 初次尝试之外最多再自动重试 3 次（共 4 次尝试）
const RETRY_BASE_DELAY_MS = 250; // 重试退避基数：第 n 次重试延迟 n * 250ms
const RECOVERY_DELAY_MS = 5000; // 重试系列被放弃后的延时自愈间隔
const MAX_RECOVERY_SERIES = 3; // 连续自愈系列数上限，超过后停止自动恢复，等待下一次生命周期事件
const MENU_MANIFEST_KEY = "menuManifest"; // 全量刷新后落盘的“应存在菜单项 id 清单”，供冷启动对账比对幽灵项
const DISABLE_ALL_ID = "disable-all"; // 一键关闭全部扩展的菜单项 id
const DISABLE_ALL_TITLE = "🚫 一键关闭所有扩展";
let lastRefreshManifest = null; // doRefreshMenu 构建时暂存，refreshSucceeded 成功后落盘

// 清单写入失败仅失去幽灵项检测能力（对账退化为逐项探测），不影响菜单本身
function writeMenuManifest(manifest) {
  if (!chrome.storage?.local || !manifest) return;
  chrome.storage.local.set({ [MENU_MANIFEST_KEY]: manifest }, () => {
    if (chrome.runtime.lastError) {
      console.warn("write menu manifest fail:", chrome.runtime.lastError.message);
    }
  });
}

// 部分平台（如 Windows）的菜单会把 & 解析为快捷键助记符前缀，
// 需转义为 && 才能显示字面的 &，否则 & 被吞掉且后续字符带下划线
function escapeMenuText(text) {
  return String(text).replace(/&/g, "&&");
}

function buildItemTitle(extName, enabled) {
  const icon = enabled ? "🟢" : "🌑";
  return `${icon} ${escapeMenuText(extName)}`;
}

// 启用扩展时 Chrome 可能弹确认框；用户主动取消属正常操作，不应刷告警
function isUserCancel(message) {
  return /did not accept/i.test(message || "");
}

function isManageable(ext) {
  // 排除自身、非普通扩展（主题等），以及 mayDisable === false（如企业策略安装、
  // 无法由用户禁用）的扩展，避免出现点击后无法切换的菜单项
  return ext.id !== chrome.runtime.id && ext.type === "extension" && ext.mayDisable !== false;
}

// 惰性复用单一 Collator 实例：localeCompare 每次比较都要重新解析 locale 与 options，
// 排序是 O(n log n) 次比较，显式 Collator.compare 明显更快
let pinyinCollator = null;

function sortExtensions(list) {
  if (!pinyinCollator) {
    pinyinCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'base', numeric: true });
  }
  // 已启用项置顶，组内按拼音/字母自然序
  return list.sort((a, b) => (b.enabled === true) - (a.enabled === true) || pinyinCollator.compare(a.name, b.name));
}

// 状态切换后：顺序未变（如末尾项切换）只更新标题；顺序变了（启用项需上移）才全量重建
function syncMenuAfterToggle(extId, enabled, extName) {
  if (isRefreshing || pendingRefresh) return updateSingleMenuItem(extId, enabled, extName);
  chrome.management.getAll((exts) => {
    if (isRefreshing || pendingRefresh) return updateSingleMenuItem(extId, enabled, extName);
    if (chrome.runtime.lastError || !exts) return updateSingleMenuItem(extId, enabled, extName);
    const ids = sortExtensions(exts.filter(isManageable)).map((e) => e.id);
    // 与最近一次成功落盘的创建顺序比对（lastRefreshManifest 即菜单实际顺序）
    const current = (lastRefreshManifest || [])
      .filter((id) => id.startsWith("toggle-"))
      .map((id) => id.slice("toggle-".length));
    const sameOrder = ids.length === current.length && ids.every((id, i) => id === current[i]);
    if (sameOrder) updateSingleMenuItem(extId, enabled, extName);
    else safeRefreshMenu();
  });
}

// 增量更新单个菜单项状态，避免全局重建导致的闪烁与竞态条件
function updateSingleMenuItem(extId, enabled, extName) {
  // 如果正在全量刷新、或已有重建在排队（重试退避/自愈窗口），标记挂起——
  // 之后的重建会以最新 getAll 结果统一生成标题；此时对可能已被 removeAll 的
  // 残缺菜单做 update 只会得到 lastError，误触发“降级全量刷新”并清零重试预算
  if (isRefreshing || pendingRefresh) {
    pendingRefresh = true;
    return;
  }

  try {
    chrome.contextMenus.update(`toggle-${extId}`, {
      title: buildItemTitle(extName, enabled)
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Update single menu failed, falling back to full refresh:", chrome.runtime.lastError.message);
        // 如果增量更新失败（例如菜单项因故丢失），则退回到全量刷新
        safeRefreshMenu();
      }
    });
  } catch (e) {
    console.error("updateSingleMenuItem error:", e);
    // 异常时退回到全量刷新以保证菜单状态一致
    safeRefreshMenu();
  }
}

function refreshMenu() {
  if (isRefreshing) {
    pendingRefresh = true;
    return;
  }
  // 事件触发的新一轮刷新：重置重试预算（checkPending 重试路径不经过这里，
  // 同一条重试链内的失败计数不受影响，重试上限不会被破坏）。
  // 本次刷新会读取最新全量状态，此前排队的重建请求可安全并入，无需再补一次
  pendingRefresh = false;
  refreshRetryCount = 0;
  abandonedSeriesCount = 0;
  doRefreshMenu();
}

function doRefreshMenu() {
  isRefreshing = true;
  const generation = ++refreshGeneration;

  chrome.contextMenus.removeAll(() => {
    // 先读取 lastError 再判断轮次：过期轮次早退时也不会产生 Unchecked runtime.lastError 噪音
    const lastErr = chrome.runtime.lastError;
    if (generation !== refreshGeneration) return; // 已有新一轮刷新接管，丢弃过期回调
    if (lastErr) {
      console.error("removeAll fail:", lastErr.message);
      refreshFailed("removeAll");
      return;
    }

    chrome.management.getAll((extensions) => {
      const lastErr = chrome.runtime.lastError;
      if (generation !== refreshGeneration) return;
      if (lastErr) {
        console.error("getAll fail:", lastErr.message);
        refreshFailed("getAll");
        return;
      }
      if (!extensions) {
        refreshFailed("extensions null");
        return;
      }

      debugLog("getAll returned", extensions.length, "items:",
        () => extensions.map(e => ({ name: e.name, enabled: e.enabled, type: e.type, installType: e.installType })));

      const list = extensions.filter(isManageable);
      debugLog("after filter", list.length, "items:", () => list.map(e => ({ name: e.name, enabled: e.enabled })));

      if (list.length === 0) {
        // 无其他可管理扩展时创建占位菜单项，避免菜单被意外清空
        lastRefreshManifest = ["terminal-root", "no-extensions"];
        chrome.contextMenus.create({
          id: "terminal-root",
          title: "扩展管家",
          contexts: ["all"]
        }, () => {
          const lastErr = chrome.runtime.lastError;
          if (generation !== refreshGeneration) return;
          if (lastErr) {
            console.error("create root menu fail:", lastErr.message);
            refreshFailed("root menu create");
            return;
          }
          chrome.contextMenus.create({
            id: "no-extensions",
            parentId: "terminal-root",
            title: "🔌 无其他可管理扩展",
            enabled: false,
            contexts: ["all"]
          }, () => {
            const lastErr = chrome.runtime.lastError;
            if (generation !== refreshGeneration) return;
            if (lastErr) {
              console.error("create placeholder fail:", lastErr.message);
              refreshFailed("placeholder create");
              return;
            }
            refreshSucceeded();
          });
        });
        return;
      }

      // 先创建根菜单，在其回调中创建子菜单以确保完美的层级顺序
      chrome.contextMenus.create({
        id: "terminal-root",
        title: "扩展管家",
        contexts: ["all"] // "all" 使其在任何右键场景（选中文本、链接、图片等）下均可用
      }, () => {
        const lastErr = chrome.runtime.lastError;
        if (generation !== refreshGeneration) return;
        if (lastErr) {
          console.error("create root menu fail:", lastErr.message);
          refreshFailed("root menu create");
          return;
        }

        let completedCount = 0;
        let failedCount = 0;
        const total = list.length;
        const sortedList = sortExtensions(list);
        lastRefreshManifest = ["terminal-root", ...sortedList.map(e => `toggle-${e.id}`), DISABLE_ALL_ID];

        sortedList.forEach(ext => {
          chrome.contextMenus.create({
            id: `toggle-${ext.id}`,
            parentId: "terminal-root",
            title: buildItemTitle(ext.name, ext.enabled),
            contexts: ["all"]
          }, () => {
            const lastErr = chrome.runtime.lastError;
            if (generation !== refreshGeneration) return;
            completedCount++;
            if (lastErr) {
              console.error(`create submenu fail for ${ext.name}:`, lastErr.message);
              failedCount++;
            }
            // 全部子菜单创建完成后统一判定本轮成败：任一失败则触发重试，
            // 避免失败项被静默吞掉、菜单缺项且重试计数被错误清零
            if (completedCount === total) {
              if (failedCount > 0) {
                refreshFailed("submenu create");
                return;
              }
              // 追加在所有扩展项之后，保证“一键关闭”始终排在菜单末尾
              chrome.contextMenus.create({
                id: DISABLE_ALL_ID,
                parentId: "terminal-root",
                title: DISABLE_ALL_TITLE,
                contexts: ["all"]
              }, () => {
                const lastErr = chrome.runtime.lastError;
                if (generation !== refreshGeneration) return;
                if (lastErr) {
                  console.error("create disable-all fail:", lastErr.message);
                  refreshFailed("disable-all create");
                } else {
                  refreshSucceeded();
                }
              });
            }
          });
        });
      });
    });
  });
}

function refreshSucceeded() {
  isRefreshing = false;
  refreshRetryCount = 0;
  abandonedSeriesCount = 0;
  writeMenuManifest(lastRefreshManifest);
  checkPending();
}

function refreshFailed(context) {
  console.error(`Refresh menu failed at: ${context}`);
  isRefreshing = false;
  refreshRetryCount++;
  // MAX_RETRIES 指“重试”次数：初次尝试之外最多再自动重试 3 次（共 4 次尝试）
  if (refreshRetryCount > MAX_RETRIES) {
    console.error(`Max retries (${MAX_RETRIES}) reached, abandoning this retry series`);
    refreshRetryCount = 0;
    pendingRefresh = false;
    abandonedSeriesCount++;
    if (abandonedSeriesCount <= MAX_RECOVERY_SERIES) {
      // 不把菜单留在“已 removeAll 未重建”的破损状态：安排一次延时自愈刷新
      // （有界恢复：连续 MAX_RECOVERY_SERIES 轮自愈仍失败才暂停，等待下一次生命周期事件）
      pendingRefresh = true;
      setTimeout(checkPending, RECOVERY_DELAY_MS);
    } else {
      console.error(`Auto recovery stopped after ${MAX_RECOVERY_SERIES} failed series; waiting for the next lifecycle event`);
    }
    return;
  }
  pendingRefresh = true;
  setTimeout(checkPending, RETRY_BASE_DELAY_MS * refreshRetryCount);
}

function checkPending() {
  // !isRefreshing 防护：退避定时器可能在其他事件触发的刷新进行到一半时到期，
  // 此时保持 pendingRefresh，由在途刷新结束后的 checkPending 统一接管
  if (pendingRefresh && !isRefreshing) {
    pendingRefresh = false;
    try {
      doRefreshMenu();
    } catch (e) {
      // 同步异常（doRefreshMenu 已置 isRefreshing = true）若不处理会导致锁永久卡死，
      // 交给 refreshFailed 复位并走重试链自愈
      console.error("doRefreshMenu sync error:", e);
      refreshFailed("doRefreshMenu sync");
    }
  }
}

function safeRefreshMenu() {
  try {
    refreshMenu();
  } catch (e) {
    console.error("refreshMenu error:", e);
    // 与 checkPending 同理：不能只复位标志，还要安排重试，否则菜单可能停在破损状态
    refreshFailed("refreshMenu sync");
  }
}

// 一键关闭：只处理可管理且当前已启用的扩展，逐个静默禁用；
// 状态变化由 onDisabled → syncMenuAfterToggle 同步：仅末尾项可增量更新，
// 顺序变化（启用项下沉）时会触发全量重建
function disableAllExtensions() {
  chrome.management.getAll((extensions) => {
    if (chrome.runtime.lastError || !extensions) return;
    extensions
      .filter((ext) => isManageable(ext) && ext.enabled)
      .forEach((ext) => {
        chrome.management.setEnabled(ext.id, false, () => {
          const err = chrome.runtime.lastError;
          if (err && !isUserCancel(err.message)) {
            console.warn(`disable all fail for ${ext.name}:`, err.message);
          }
        });
      });
  });
}

// 状态记忆：把每个扩展的启用状态快照存进 storage 的 JSON（stateMemory），
// 扩展重新安装/更新（management.onInstalled）时自动套用，免去重装后逐个关一遍
const MEMORY_KEY = "stateMemory";
const PERSIST_DELAY_MS = 200; // 批量切换时合并写入，避免写风暴
let stateMemory = null;
let memoryLoaded = false; // 读取失败时禁止回写，避免用空快照覆盖真实记忆
let memoryGen = 0; // 版本号：onChanged 抢先写入后作废旧 get 的迟到回调
const memoryWaiters = [];
let persistTimer = null;

// 懒加载快照：加载期间的调用排队，全部复用同一份内存对象
function withMemory(fn) {
  if (stateMemory) return fn(stateMemory);
  memoryWaiters.push(fn);
  if (memoryWaiters.length > 1) return; // 已有在途 get，排队等它统一回放
  const gen = ++memoryGen; // 只有真正发起 get 才递增，排队调用不得改动代号
  chrome.storage.local.get(MEMORY_KEY, (data) => {
    if (gen !== memoryGen) return; // onChanged 已接管并回放 waiter，丢弃迟到读
    memoryLoaded = !chrome.runtime.lastError;
    stateMemory = (memoryLoaded && data && data[MEMORY_KEY]) || {};
    for (const waiter of memoryWaiters.splice(0)) waiter(stateMemory);
  });
}

// 逐条按 ts 取新合并（墓碑也带 ts，故删除可跨设备传播，不会被旧快照复活）
function mergeMemory(base, incoming) {
  for (const [id, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== "object") continue;
    const cur = base[id];
    if (!cur || (entry.ts || 0) >= (cur.ts || 0)) base[id] = entry;
  }
  return base;
}

function persistMemory() {
  if (!memoryLoaded) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.local.set({ [MEMORY_KEY]: stateMemory }, () => {
      if (chrome.runtime.lastError) {
        console.warn("persist state memory fail:", chrome.runtime.lastError.message);
        return;
      }
      scheduleCloudPush();
    });
  }, PERSIST_DELAY_MS);
}

function rememberState(ext) {
  if (!isManageable(ext)) return;
  withMemory((mem) => {
    mem[ext.id] = { name: ext.name, enabled: !!ext.enabled, ts: Date.now() };
    persistMemory();
  });
}

// 套用记忆：无记录则记下现状；状态不同才切换
function restoreState(ext) {
  if (!isManageable(ext)) return;
  withMemory((mem) => {
    const saved = mem[ext.id];
    // 墓碑表示用户主动移除：不套用旧状态、也不在批量恢复时补录，
    // 只有真正的重新安装（onInstalled）才会清除墓碑并重新记录
    if (saved?.deleted) return;
    if (!saved || typeof saved.enabled !== "boolean") return rememberState(ext);
    if (saved.enabled === !!ext.enabled) return;
    chrome.management.setEnabled(ext.id, saved.enabled, () => {
      const err = chrome.runtime.lastError;
      if (!err) return;
      if (isUserCancel(err.message)) {
        // 用户拒绝启用：记下真实状态，避免每次启动反复弹确认框
        rememberState({ ...ext, enabled: !saved.enabled });
        return;
      }
      console.warn(`restore state fail for ${ext.name}:`, err.message);
    });
  });
}

// 用户主动卸载 = 不再需要：写墓碑（带新 ts）而非直接删除，
// 这样删除动作能作为一次“更新”传播到云端与其它设备，不会被旧快照复活
function forgetState(id) {
  withMemory((mem) => {
    const cur = mem[id];
    if (!cur || cur.deleted) return;
    mem[id] = { ...cur, deleted: true, ts: Date.now() };
    persistMemory();
  });
}

function restoreAllStates(done) {
  chrome.management.getAll((exts) => {
    if (!chrome.runtime.lastError && exts) {
      for (const ext of exts) restoreState(ext);
    }
    if (done) done();
  });
}

// 云端存储（Cloudflare Worker + KV）：配置了地址与 TOKEN 时启用同步
const CLOUD_KEY = "cloudConfig";
const CLOUD_PUSH_DELAY_MS = 1500;
let cloudConfig = null;
let cloudPushTimer = null;

async function getCloudConfig() {
  if (cloudConfig) return cloudConfig;
  return new Promise((resolve) => {
    chrome.storage.local.get(CLOUD_KEY, (data) => {
      if (chrome.runtime.lastError) return resolve({}); // 读失败不缓存空配置，下次可读回真实配置
      cloudConfig = (data && data[CLOUD_KEY]) || {};
      resolve(cloudConfig);
    });
  });
}

async function cloudRequest(method, body) {
  const cfg = await getCloudConfig();
  const url = String(cfg.url || "").trim().replace(/\/+$/, "");
  const token = String(cfg.token || "").trim();
  if (!/^https?:\/\//.test(url) || !token) return null;
  try {
    const res = await fetch(`${url}/state`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body
    });
    if (!res.ok) {
      console.warn("cloud request fail:", res.status);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn("cloud request error:", e.message);
    return null;
  }
}

// 状态变化后防抖推送，避免批量切换时打爆 KV 写入额度
function scheduleCloudPush() {
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(async () => {
    const cfg = await getCloudConfig();
    if (!cfg.url || !cfg.token || !stateMemory) return;
    await cloudRequest("PUT", JSON.stringify(stateMemory));
  }, CLOUD_PUSH_DELAY_MS);
}

// 工具栏角标：记忆里记录、但当前浏览器未安装的扩展数量
// （读本地快照即可，省掉一次云端往返；Chrome 不允许扩展静默安装其他扩展）
function updateMissingBadge() {
  if (!chrome.action?.setBadgeText) return;
  withMemory((mem) => {
    chrome.management.getAll((exts) => {
      if (chrome.runtime.lastError || !exts) return;
      const have = new Set(exts.map((e) => e.id));
      const haveNames = new Set(exts.map((e) => e.name));
      const count = Object.keys(mem).filter((id) =>
        !mem[id]?.deleted && !have.has(id) && !haveNames.has(mem[id]?.name)).length;
      chrome.action.setBadgeText({ text: count ? String(count) : "" });
      if (count) chrome.action.setBadgeBackgroundColor({ color: "#F0A83C" });
    });
  });
}

// 启动时校准记忆：拉取云端合并后，遍历全部扩展补录缺失项并套用记忆
async function initMemoryState() {
  // 总是拉取云端并按 ts 逐条合并（不再“本地非空就跳过”），否则本地与云端各有更新时会互相丢失
  const remote = await cloudRequest("GET");
  // 在同一 withMemory 回调里先合并云端再补录，确保补录看到的是合并后的记忆，
  // 否则“首次安装按云端恢复”会被并发补录的 now ts 覆盖
  withMemory((mem) => {
    if (remote && typeof remote === "object" && !Array.isArray(remote)) mergeMemory(mem, remote);
    // 补录未记录的扩展（restoreAllStates 内部仍是异步 getAll，但补录只读当前 mem 决定动作）
    chrome.management.getAll((exts) => {
      if (!chrome.runtime.lastError && exts) for (const ext of exts) restoreState(ext);
      persistMemory(); // 合并 + 补录结果落盘并触发上云
      updateMissingBadge();
    });
  });
}

// 后台持续播放：popup 只写 storage 开关，这里负责注册/注销 MAIN world 脚本
const KEEP_ALIVE_KEY = "keepAlive";
const KEEP_ALIVE_ID = "keep-alive";

// payload 为 { files: [...] } 或 { func }；对全部标签的每个 frame 注入
function runInAllTabs(payload) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs || []) {
      if (tab.id == null) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: "MAIN",
        ...payload
      }, () => {
        if (chrome.runtime.lastError) return; // chrome:// 等页面不可注入，静默跳过
      });
    }
  });
}

function applyKeepAlive(enabled) {
  if (!chrome.scripting) return;
  // 先注销再注册，保证开关来回切换时注册态唯一
  chrome.scripting.unregisterContentScripts({ ids: [KEEP_ALIVE_ID] }, () => {
    void chrome.runtime.lastError;
    if (!enabled) {
      runInAllTabs({ func: () => window.__butlerKeepAlive?.disable() }); // 已打开的页面立即还原
      return;
    }
    chrome.scripting.registerContentScripts([{
      id: KEEP_ALIVE_ID,
      matches: ["<all_urls>"],
      js: ["keepAlive.js"],
      runAt: "document_start",
      allFrames: true,
      world: "MAIN"
    }], () => {
      void chrome.runtime.lastError;
      runInAllTabs({ files: ["keepAlive.js"] }); // 已打开的页面立即生效
    });
  });
}

// SW 重启后校准注册状态：已一致则不做任何注入，避免无谓开销
function syncKeepAlive() {
  if (!chrome.scripting || !chrome.storage?.local) return;
  chrome.storage.local.get(KEEP_ALIVE_KEY, (data) => {
    // 默认开启：只有显式写入 false 才算关闭
    const enabled = !data || data[KEEP_ALIVE_KEY] !== false;
    chrome.scripting.getRegisteredContentScripts({ ids: [KEEP_ALIVE_ID] }, (scripts) => {
      void chrome.runtime.lastError;
      if (enabled !== !!(scripts && scripts.length)) applyKeepAlive(enabled);
    });
  });
}

// SW 冷启动对账：本扩展被禁用的窗口期内会错过其他扩展的安装/卸载事件，
// 重新启用后没有任何生命周期事件可依赖（onInstalled/onStartup 均不触发）。
// 分两级工作：
//   1. 清单比对——与上次全量刷新落盘的“应存在菜单项 id 清单”比对，不一致
//      （含探测法无法发现的幽灵残留项）直接全量重建；
//   2. 逐项探测——清单一致（或无清单）时，对每个应存在的菜单项执行一次
//      update（顺带同步最新名称与状态图标），只有发现菜单项缺失才降级为
//      全量刷新，菜单一致时零重建、零闪烁。
function reconcileMenus() {
  if (isRefreshing || pendingRefresh) return;
  const gen = refreshGeneration; // 用于识别对账期间是否有新一轮全量刷新启动
  chrome.management.getAll((extensions) => {
    if (isRefreshing || pendingRefresh || gen !== refreshGeneration) return;
    if (chrome.runtime.lastError || !extensions) return; // 拿不到列表时保持现状，等待下一次事件

    // 探测顺序与结果无关，无需排序
    const list = extensions.filter(isManageable);
    const expected = ["terminal-root", ...list.map(e => `toggle-${e.id}`)];
    if (list.length === 0) expected.push("no-extensions");
    else expected.push(DISABLE_ALL_ID);

    if (!chrome.storage?.local) {
      probeMenus(list, gen);
      return;
    }
    chrome.storage.local.get(MENU_MANIFEST_KEY, (data) => {
      const lastErr = chrome.runtime.lastError;
      if (isRefreshing || pendingRefresh || gen !== refreshGeneration) return;
      if (lastErr) {
        console.warn("read menu manifest fail:", lastErr.message);
        probeMenus(list, gen);
        return;
      }
      const stored = data && data[MENU_MANIFEST_KEY];
      if (Array.isArray(stored) && !sameIdSet(stored, expected)) {
        debugLog("reconcile: manifest mismatch (ghost/missing items), full refresh");
        safeRefreshMenu();
        return;
      }
      probeMenus(list, gen);
    });
  });
}

// id 集合一致性：顺序无关比对（清单按拼音序落盘，探测按 getAll 原序构建）
function sameIdSet(a, b) {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

// 逐项探测修正：同步最新名称与状态图标，发现菜单项缺失才降级全量刷新
function probeMenus(list, gen) {
  const probes = [
    { id: "terminal-root", title: "扩展管家" },
    ...list.map(e => ({ id: `toggle-${e.id}`, title: buildItemTitle(e.name, e.enabled) }))
  ];
  if (list.length === 0) {
    probes.push({ id: "no-extensions", title: "🔌 无其他可管理扩展" });
  } else {
    probes.push({ id: DISABLE_ALL_ID, title: DISABLE_ALL_TITLE });
  }

  let remaining = probes.length;
  let missing = false;
  for (const probe of probes) {
    chrome.contextMenus.update(probe.id, { title: probe.title }, () => {
      if (chrome.runtime.lastError) missing = true;
      remaining--;
      // 只有当前没有别的刷新在途/排队、且对账开始后没有新刷新轮次启动时，
      // 才认定“菜单缺失”成立，否则交给在途/刚完成的刷新兜底，避免多余重建
      if (remaining === 0 && missing && !isRefreshing && !pendingRefresh && gen === refreshGeneration) {
        debugLog("reconcile: menu items missing, triggering full refresh");
        safeRefreshMenu();
      }
    });
  }
}

(function init() {
  if (!chrome?.runtime || !chrome?.contextMenus || !chrome?.management) {
    console.error("CORE: Required Chrome APIs not available");
    return;
  }

  // 1. 注册核心交互点击监听器（必须在 Service Worker 顶层同步注册，以确保唤醒时事件被捕获）
  chrome.contextMenus.onClicked.addListener((info) => {
    if (!info.menuItemId || typeof info.menuItemId !== "string") return;
    if (info.menuItemId === DISABLE_ALL_ID) {
      disableAllExtensions();
      return;
    }
    if (!info.menuItemId.startsWith("toggle-")) return;

    const targetId = info.menuItemId.replace("toggle-", "");

    chrome.management.get(targetId, (ext) => {
      if (chrome.runtime.lastError) {
        console.error("get fail:", chrome.runtime.lastError.message);
        return;
      }
      if (!ext) return;

      const newState = !ext.enabled;
      chrome.management.setEnabled(targetId, newState, () => {
        const err = chrome.runtime.lastError;
        if (err && !isUserCancel(err.message)) {
          console.error("setEnabled fail:", err.message);
        }
        // 不打开 chrome://extensions，保持静默体验
      });
    });
  });

  // 2. 生命周期与状态同步监听

  // 只在安装、更新以及浏览器启动时进行完整的全局重建（MV3 菜单是持久化的，
  // 平时唤醒由 init 末尾的冷启动对账兜底）；安装时额外从云端恢复状态基线
  chrome.runtime.onInstalled.addListener(() => {
    safeRefreshMenu();
    updateMissingBadge();
    initMemoryState();
  });
  chrome.runtime.onStartup.addListener(() => {
    safeRefreshMenu();
    initMemoryState();
  });

  // 扩展启用/禁用时，使用轻量级的增量更新，绝不调用 removeAll() 重建所有菜单，避免闪烁和竞态
  chrome.management.onEnabled.addListener((info) => {
    if (isManageable(info)) {
      rememberState(info);
      syncMenuAfterToggle(info.id, true, info.name);
    }
  });
  chrome.management.onDisabled.addListener((info) => {
    if (isManageable(info)) {
      rememberState(info);
      syncMenuAfterToggle(info.id, false, info.name);
    }
  });

  // 扩展安装/卸载导致列表数量改变时，需要完整重新渲染排列；
  // 安装/更新后先按记忆恢复状态，再重建菜单
  chrome.management.onInstalled.addListener((info) => {
    if (isManageable(info)) {
      // 重新安装是用户的明确意图：清除可能的墓碑，按当前真实状态重新纳入记忆
      withMemory((mem) => {
        if (mem[info.id]?.deleted) {
          delete mem[info.id];
          persistMemory();
        }
      });
      restoreState(info);
      safeRefreshMenu();
    }
  });
  chrome.management.onUninstalled.addListener((id) => {
    if (id !== chrome.runtime.id) {
      forgetState(id);
      safeRefreshMenu();
      updateMissingBadge();
    }
  });

  // 3. 后台持续播放开关：跟随 storage 变化注册/注销 MAIN world 脚本
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[KEEP_ALIVE_KEY]) {
      applyKeepAlive(changes[KEEP_ALIVE_KEY].newValue !== false);
    }
    // 记忆被外部改写（如面板里忽略某条记录 / 云端拉取）后立即套用并同步上云
    if (changes[MEMORY_KEY]) {
      memoryGen++; // 使在途的 storage.get 迟到回调失效，避免旧值覆盖新值
      memoryLoaded = true; // onChanged 携带的是已落盘的真实值，可用于后续持久化
      stateMemory = changes[MEMORY_KEY].newValue || {};
      for (const waiter of memoryWaiters.splice(0)) waiter(stateMemory); // 回放加载期间排队的调用
      restoreAllStates();
      scheduleCloudPush();
    }
    if (changes[CLOUD_KEY]) cloudConfig = null; // 地址或 TOKEN 变了，下次请求重新读取
  });
  syncKeepAlive();

  // 4. 冷启动对账：修正禁用窗口期错过的变化（含本扩展被禁用后重新启用的场景）
  reconcileMenus();
  updateMissingBadge();
})();
