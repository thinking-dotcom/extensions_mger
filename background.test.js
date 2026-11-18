/**
 * background.js 行为验证（零依赖，直接 `node background.test.js` 运行）
 *
 * 用可注入故障的 chrome API mock 驱动真实的 background.js（每次用例独立 eval，
 * 模块状态完全隔离）。mock 的异步往返耗时随环境浮动，因此所有时序敏感断言
 * 均通过 waitFor 轮询等待确定性的结束信号，而不是固定 sleep。
 * 另外在加载时对源码打"仅测试用"补丁，把 isRefreshing/pendingRefresh 暴露到
 * env.swState，用于精确定位重试退避窗口。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await SLEEP(5);
  }
  return fn();
}

const results = [];
let currentEnv = null; // 失败取证：check 失败时自动转储当前 env 的完整状态
function check(name, cond, extra) {
  if (!cond && currentEnv) {
    const e = currentEnv;
    const dump =
      `menus=${JSON.stringify([...e.menus.entries()].map(([k, v]) => `${k}=${v.title}${v.enabled === false ? '(disabled)' : ''}`))}` +
      ` errors=${JSON.stringify(e.errors)}` +
      ` logTail=${e.log.slice(-14).join(',')}`;
    extra = extra ? `${extra} ‖ ${dump}` : dump;
  }
  results.push({ name, ok: !!cond, extra: extra === undefined ? '' : String(extra) });
}

function defaultExts() {
  return [
    { id: 'ext-aaaa', name: 'A&B Tools', enabled: true, type: 'extension', mayDisable: true },
    { id: 'ext-bbbb', name: '禅模式', enabled: false, type: 'extension', mayDisable: true },
    { id: 'ext-cccc', name: 'Item 10', enabled: true, type: 'extension', mayDisable: true },
    { id: 'ext-dddd', name: 'Item 2', enabled: true, type: 'extension', mayDisable: true },
    { id: 'self-id', name: '扩展管家', enabled: true, type: 'extension', mayDisable: true },
    { id: 'ext-theme', name: 'My Theme', enabled: true, type: 'theme' },
    { id: 'ext-policy', name: 'Policy Ext', enabled: true, type: 'extension', mayDisable: false },
  ];
}

function makeEnv(opts = {}) {
  const exts = (opts.exts || defaultExts()).map((e) => ({ ...e }));
  const menus = new Map(); // id -> {id,title,parentId,enabled}
  const log = [];
  const errors = [];
  const flags = { failRemoveAll: 0, failGetAll: 0, throwRemoveAllSync: 0, failStorageGet: 0, declineEnable: 0, delays: {} };
  Object.assign(flags, opts.flags || {}); // 启动阶段就生效的故障注入
  // 可跨 env 共享，模拟 chrome.storage.local 在 SW 重启后保留
  const storageData = opts.storageData || new Map();
  // 由"仅测试用"源码补丁写入，用于从外部观察 SW 内部锁状态
  const swState = { isRefreshing: false, pendingRefresh: false };
  const listeners = {
    rtOnInstalled: [], rtOnStartup: [],
    mgmtOnEnabled: [], mgmtOnDisabled: [], mgmtOnInstalled: [], mgmtOnUninstalled: [],
    cmOnClicked: [], storageOnChanged: [],
  };
  const registered = []; // 动态注册的 content script（后台持续播放）
  const injections = []; // executeScript 调用记录

  const ev = (name) => ({ addListener: (f) => listeners[name].push(f) });
  const fire = (name, ...args) => listeners[name].forEach((f) => f(...args));
  const fireLater = (name, arg) => setTimeout(() => fire(name, arg), 0);

  // 与 Chrome 一致：结果在调用时确定，lastError 仅在回调执行期间可见
  const api = (name, impl) => (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    log.push(name);
    let err = null, out;
    try {
      out = impl(args) || [null];
    } catch (e) {
      log.push(name + ':THROW');
      throw e;
    }
    [err, out] = [out[0], out[1]];
    setTimeout(() => {
      if (err) { chromeMock.runtime.lastError = { message: err }; errors.push(`${name}: ${err}`); }
      try { if (cb) cb(out); } finally { delete chromeMock.runtime.lastError; }
    }, flags.delays[name] || 0);
  };

  const chromeMock = {
    runtime: {
      id: 'self-id',
      getURL: (p) => `chrome-extension://self-id/${p}`,
      onInstalled: ev('rtOnInstalled'),
      onStartup: ev('rtOnStartup'),
    },
    contextMenus: {
      removeAll: api('removeAll', () => {
        if (flags.throwRemoveAllSync > 0) { flags.throwRemoveAllSync--; throw new Error('sync removeAll boom'); }
        if (flags.failRemoveAll > 0) { flags.failRemoveAll--; return ['removeAll boom']; }
        menus.clear();
        return [null];
      }),
      create: api('create', (args) => {
        const p = args[0];
        if (menus.has(p.id)) return [`Duplicate id '${p.id}'`];
        menus.set(p.id, { ...p });
        return [null];
      }),
      update: api('update', (args) => {
        const [id, props] = args;
        if (!menus.has(id)) return [`Cannot find menu item with id '${id}'`];
        Object.assign(menus.get(id), props);
        return [null];
      }),
      onClicked: ev('cmOnClicked'),
    },
    management: {
      getAll: api('getAll', () =>
        flags.failGetAll > 0 ? (flags.failGetAll--, ['getAll boom']) : [null, exts.map((e) => ({ ...e }))]),
      get: api('get', (args) => {
        const e = exts.find((x) => x.id === args[0]);
        return e ? [null, { ...e }] : [`No item with id '${args[0]}'`];
      }),
      setEnabled: api('setEnabled', (args) => {
        const [id, en] = args;
        const e = exts.find((x) => x.id === id);
        if (!e) return [`No item with id '${id}'`];
        if (e.mayDisable === false) return ['not disableable'];
        if (en && flags.declineEnable > 0) { // 模拟用户在确认框点了取消
          flags.declineEnable--;
          return ['The user did not accept the re-enable dialog.'];
        }
        e.enabled = en;
        fireLater(en ? 'mgmtOnEnabled' : 'mgmtOnDisabled', { ...e });
        return [null];
      }),
      onEnabled: ev('mgmtOnEnabled'),
      onDisabled: ev('mgmtOnDisabled'),
      onInstalled: ev('mgmtOnInstalled'),
      onUninstalled: ev('mgmtOnUninstalled'),
    },
    storage: {
      onChanged: ev('storageOnChanged'),
      local: {
        get: api('storage.get', (args) => {
          if (flags.failStorageGet > 0) { flags.failStorageGet--; return ['storage get boom']; }
          const [keys] = args;
          const out = {};
          const wanted = keys === null ? [...storageData.keys()] : (Array.isArray(keys) ? keys : [keys]);
          for (const k of wanted) { if (storageData.has(k)) out[k] = storageData.get(k); }
          return [null, out];
        }),
        set: api('storage.set', (args) => {
          const changes = {};
          for (const [k, v] of Object.entries(args[0])) { storageData.set(k, v); changes[k] = { newValue: v }; }
          setTimeout(() => fire('storageOnChanged', changes, 'local'), 0);
          return [null];
        }),
        remove: api('storage.remove', (args) => {
          for (const k of (Array.isArray(args[0]) ? args[0] : [args[0]])) storageData.delete(k);
          return [null];
        }),
      },
    },
    tabs: {
      query: api('tabs.query', () => [null, [{ id: 1, url: 'https://example.com/' }]]),
    },
    scripting: {
      registerContentScripts: api('registerContentScripts', (args) => {
        for (const s of args[0]) registered.push({ ...s });
        return [null];
      }),
      unregisterContentScripts: api('unregisterContentScripts', (args) => {
        for (const id of args[0].ids) {
          const i = registered.findIndex((s) => s.id === id);
          if (i >= 0) registered.splice(i, 1);
        }
        return [null];
      }),
      getRegisteredContentScripts: api('getRegisteredContentScripts', (args) => {
        const ids = args[0] && args[0].ids;
        const list = ids ? registered.filter((s) => ids.includes(s.id)) : registered;
        return [null, list.map((s) => ({ ...s }))];
      }),
      executeScript: api('executeScript', (args) => {
        injections.push(args[0]);
        return [null, []];
      }),
    },
  };

  // 仅测试用补丁：在关键状态迁移点把内部锁状态暴露给断言（direct eval 可见 makeEnv 作用域）
  let src = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
  src = src
    .replace('function doRefreshMenu() {',
      'function doRefreshMenu() { swState.isRefreshing = true; swState.pendingRefresh = false;')
    .replace('function refreshSucceeded() {',
      'function refreshSucceeded() { swState.isRefreshing = false; swState.pendingRefresh = pendingRefresh;')
    .replace(
      '  pendingRefresh = true;\n  setTimeout(checkPending, RETRY_BASE_DELAY_MS * refreshRetryCount);',
      '  pendingRefresh = true;\n  swState.isRefreshing = isRefreshing; swState.pendingRefresh = pendingRefresh;\n' +
      '  setTimeout(checkPending, RETRY_BASE_DELAY_MS * refreshRetryCount);');

  // 关键：用 new Function 把 chrome/swState 变成本 env 私有的闭包参数。
  // 若挂到 global.chrome，前一个 env 残留的定时器回调会在后续测试期间
  // 解析到新 env 的 mock，造成跨 env 污染（重复 id、日志串线等假象）。
  if (opts.seed) opts.seed({ menus, exts, storageData }); // 在 SW 启动前预置菜单/清单状态
  const noFetch = () => Promise.reject(new Error('fetch disabled in test'));
  new Function('chrome', 'swState', 'fetch', src)(chromeMock, swState, opts.fetch || noFetch);

  return { exts, menus, log, errors, flags, swState, storageData, registered, injections, fire, listeners };
}

// ---- 断言辅助 ----
const countLog = (env, name) => env.log.filter((x) => x === name).length;
const manageable = (env) => env.exts.filter((e) => e.id !== 'self-id' && e.type === 'extension' && e.mayDisable !== false);
const esc = (s) => s.replace(/&/g, '&&');
const expectedTitle = (e) => `${e.enabled ? '🟢' : '🌑'} ${esc(e.name)}`;

function expectedKeys(env) {
  const list = manageable(env);
  if (list.length === 0) return ['terminal-root', 'no-extensions'];
  const coll = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'base', numeric: true });
  list.sort((a, b) => (b.enabled === true) - (a.enabled === true) || coll.compare(a.name, b.name));
  return ['terminal-root', ...list.map((e) => `toggle-${e.id}`), 'disable-all'];
}

function menusCorrect(env) {
  const keys = expectedKeys(env);
  if (env.menus.size !== keys.length) return false;
  for (const id of keys) {
    const m = env.menus.get(id);
    if (!m) return false;
    if (id === 'terminal-root') { if (m.title !== '扩展管家') return false; continue; }
    if (id === 'no-extensions') { if (m.title !== '🔌 无其他可管理扩展') return false; continue; }
    if (id === 'disable-all') { if (m.title !== '🚫 一键关闭所有扩展') return false; continue; }
    const e = env.exts.find((x) => `toggle-${x.id}` === id);
    if (m.title !== expectedTitle(e)) return false;
  }
  return true;
}

function seedConsistentMenus(env) {
  env.menus.set('terminal-root', { id: 'terminal-root', title: '扩展管家' });
  for (const e of manageable(env)) {
    env.menus.set(`toggle-${e.id}`, { id: `toggle-${e.id}`, title: expectedTitle(e), parentId: 'terminal-root' });
  }
  env.menus.set('disable-all', { id: 'disable-all', title: '🚫 一键关闭所有扩展', parentId: 'terminal-root' });
}

const aaaa = () => ({ id: 'ext-aaaa', name: 'A&B Tools', enabled: true, type: 'extension', mayDisable: true });

// ---- 用例 ----
async function testA_coldBootReconcile() {
  const env = makeEnv();
  currentEnv = env; // 菜单为空
  check('A1 冷启动对账触发恰好一次全量刷新',
    await waitFor(() => menusCorrect(env), 5000) && countLog(env, 'removeAll') === 1,
    `removeAll=${countLog(env, 'removeAll')}`);
  check('A2 菜单内容与顺序正确（拼音序+数字自然序）',
    JSON.stringify([...env.menus.keys()]) === JSON.stringify(expectedKeys(env)),
    [...env.menus.keys()].join(','));
  check('A3 & 转义为 &&', env.menus.get('toggle-ext-aaaa')?.title === '🟢 A&&B Tools', env.menus.get('toggle-ext-aaaa')?.title);
  check('A4 排除自身/主题/不可禁用项', !env.menus.has('toggle-self-id') && !env.menus.has('toggle-ext-theme') && !env.menus.has('toggle-ext-policy'));
  await waitFor(() => !env.swState.isRefreshing, 5000); // 等 create 回调链走完（refreshSucceeded 落盘清单）
  check('A5 全量刷新后清单落盘',
    JSON.stringify([...(env.storageData.get('menuManifest') || [])].sort()) === JSON.stringify([...expectedKeys(env)].sort()),
    JSON.stringify(env.storageData.get('menuManifest')));
}

async function testB_reconcileConsistent() {
  const env = makeEnv();
  currentEnv = env;
  seedConsistentMenus(env);
  await SLEEP(400); // 负向断言：探测回调即使再慢也不可能触发刷新（impl 无错误）
  check('B1 菜单一致时零重建', countLog(env, 'removeAll') === 0 && countLog(env, 'create') === 0);
  check('B2 对账探测执行（根+4 项+一键关闭）', countLog(env, 'update') === 6, `update=${countLog(env, 'update')}`);
}

async function testB2_reconcileSyncsStaleTitle() {
  const env = makeEnv();
  currentEnv = env;
  seedConsistentMenus(env);
  env.menus.get('toggle-ext-aaaa').title = '🟢 Old Name'; // 模拟禁用窗口期内被改名
  await SLEEP(400);
  check('B3 标题漂移被探测同步且不触发重建',
    env.menus.get('toggle-ext-aaaa').title === '🟢 A&&B Tools' && countLog(env, 'removeAll') === 0,
    env.menus.get('toggle-ext-aaaa').title);
}

async function testC_clickToggleFlow() {
  const env = makeEnv();
  currentEnv = env;
  await waitFor(() => menusCorrect(env), 5000);
  const beforeRemove = countLog(env, 'removeAll');
  env.listeners.cmOnClicked[0]({ menuItemId: 'toggle-ext-aaaa' });
  check('C1 setEnabled 切换生效',
    await waitFor(() => env.exts.find((e) => e.id === 'ext-aaaa').enabled === false, 3000));
  check('C2 顺序变化时触发一次全量重建',
    await waitFor(() => countLog(env, 'removeAll') === beforeRemove + 1, 5000),
    `removeAll=${countLog(env, 'removeAll')}`);
  check('C3 已禁用项移出顶部组，菜单按新顺序重建',
    await waitFor(() => menusCorrect(env), 5000) &&
    [...env.menus.keys()].indexOf('toggle-ext-aaaa') > [...env.menus.keys()].indexOf('toggle-ext-cccc'),
    [...env.menus.keys()].join(','));
  env.listeners.cmOnClicked[0]({ menuItemId: 'toggle-ghost' }); // 已卸载扩展的残留项
  await SLEEP(200);
  check('C4 幽灵项点击静默失败不崩溃', menusCorrect(env));
}

// 末尾项切换不改变整体顺序时应保持增量更新（零重建）
async function testC2_toggleTailKeepsOrder() {
  const env = makeEnv({
    exts: [
      { id: 'e1', name: 'Alpha', enabled: true, type: 'extension', mayDisable: true },
      { id: 'e2', name: 'Beta', enabled: true, type: 'extension', mayDisable: true },
      { id: 'e3', name: 'Gamma', enabled: true, type: 'extension', mayDisable: true },
    ],
  });
  currentEnv = env;
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000);
  const beforeRemove = countLog(env, 'removeAll');
  env.listeners.cmOnClicked[0]({ menuItemId: 'toggle-e3' });
  check('C5 末尾项禁用后顺序不变，走增量更新',
    await waitFor(() => env.menus.get('toggle-e3')?.title === '🌑 Gamma', 3000) &&
    countLog(env, 'removeAll') === beforeRemove,
    `removeAll=${countLog(env, 'removeAll')}`);
  check('C6 菜单顺序仍为 Alpha,Beta,Gamma',
    [...env.menus.keys()].join(',') === 'terminal-root,toggle-e1,toggle-e2,toggle-e3,disable-all',
    [...env.menus.keys()].join(','));
}

async function testD_updateDuringRefreshDeferred() {
  const env = makeEnv();
  currentEnv = env;
  // 等启动刷新完全落地（空闲）再开火，removeAll 计数才确定
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000);
  const beforeRemove = countLog(env, 'removeAll');
  const beforeUpdate = countLog(env, 'update');
  const info = { ...aaaa(), enabled: false }; // onDisabled 携带的是新状态
  env.exts.find((e) => e.id === 'ext-aaaa').enabled = false;
  env.fire('rtOnInstalled', { ...info });   // 触发全量刷新（同步置 isRefreshing=true）
  env.fire('mgmtOnDisabled', { ...info });  // 同一时刻的增量更新
  check('D2 收尾重建后标题为新状态',
    (await waitFor(() => menusCorrect(env), 5000)) && env.menus.get('toggle-ext-aaaa')?.title === '🌑 A&&B Tools',
    env.menus.get('toggle-ext-aaaa')?.title);
  check('D3 恰好两次 removeAll（刷新+收尾重建）',
    await waitFor(() => countLog(env, 'removeAll') === beforeRemove + 2, 5000),
    `removeAll=${countLog(env, 'removeAll')}`);
  check('D1 刷新期间增量更新被挂起（无 update 调用）', countLog(env, 'update') === beforeUpdate, `update=${countLog(env, 'update')}`);
  check('D4 无重复 id 错误', env.errors.every((e) => !e.startsWith('create')));
}

async function testE_retryBackoffAndRecovery() {
  const env = makeEnv();
  currentEnv = env;
  env.flags.failRemoveAll = 6; // 前 6 次 removeAll 失败：第 1 轮系列放弃 → 5s 自愈 → 第 2 轮第 3 次成功
  check('E1 连续失败后经自愈恢复，菜单完整', await waitFor(() => menusCorrect(env), 15000));
  check('E2 removeAll 恰好 7 次（6 败 + 1 成，符合退避节奏）', countLog(env, 'removeAll') === 7, `removeAll=${countLog(env, 'removeAll')}`);
  check('E3 无重复 id 错误', env.errors.every((e) => !e.startsWith('create')));
}

async function testF_syncThrowDoesNotDeadlock() {
  const env = makeEnv();
  currentEnv = env;
  env.flags.throwRemoveAllSync = 1; // doRefreshMenu 同步段抛异常
  env.fire('rtOnStartup');
  check('F1 同步异常后经重试链恢复，锁未卡死', await waitFor(() => menusCorrect(env), 5000));
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000); // 等在途刷新结束，计数才确定
  const before = countLog(env, 'removeAll');
  env.fire('rtOnInstalled', aaaa());
  check('F2 后续刷新仍正常工作',
    (await waitFor(() => menusCorrect(env), 5000)) && countLog(env, 'removeAll') === before + 1, `removeAll=${countLog(env, 'removeAll')}`);
}

async function testG_rapidEventsDedup() {
  const env = makeEnv();
  currentEnv = env;
  // 先等到完全空闲（在途刷新结束），使三连事件确定性地落在空闲态
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000);
  const before = countLog(env, 'removeAll');
  env.fire('rtOnInstalled', aaaa());
  env.fire('rtOnInstalled', aaaa());
  env.fire('rtOnInstalled', aaaa()); // 同步三连事件
  check('G1 三次事件仅消耗两次 removeAll（在途 + 收尾重建）',
    await waitFor(() => countLog(env, 'removeAll') === before + 2, 5000),
    `removeAll=${countLog(env, 'removeAll')}`);
  check('G3 菜单最终正确', await waitFor(() => menusCorrect(env), 5000));
  check('G2 无重复 id 错误', env.errors.every((e) => !e.startsWith('create')));
}

async function testH_emptyListPlaceholder() {
  const env = makeEnv({
    exts: [
      { id: 'self-id', name: '扩展管家', enabled: true, type: 'extension', mayDisable: true },
      { id: 'ext-theme', name: 'My Theme', enabled: true, type: 'theme' },
      { id: 'ext-policy', name: 'Policy Ext', enabled: true, type: 'extension', mayDisable: false },
    ],
  });
  currentEnv = env;
  check('H1 空列表创建占位菜单且不可点',
    await waitFor(() => menusCorrect(env), 5000) &&
    env.menus.get('no-extensions')?.title === '🔌 无其他可管理扩展' && env.menus.get('no-extensions')?.enabled === false);
  check('H2 仅根+占位两项', JSON.stringify([...env.menus.keys()]) === JSON.stringify(['terminal-root', 'no-extensions']));
}

async function testI_getAllFailureRetries() {
  const env = makeEnv();
  currentEnv = env;
  env.flags.failGetAll = 1; // 刷新阶段的 getAll 失败
  check('I1 getAll 失败后重试成功', await waitFor(() => menusCorrect(env), 5000));
  check('I2 恰好两次 removeAll', countLog(env, 'removeAll') === 2, `removeAll=${countLog(env, 'removeAll')}`);
}

async function testJ_updateSkippedInBackoffWindow() {
  const env = makeEnv();
  currentEnv = env;
  env.flags.failGetAll = 1; // 刷新阶段的 getAll 失败
  check('J0 精确进入退避窗口',
    await waitFor(() => env.swState.pendingRefresh === true && env.swState.isRefreshing === false, 5000));
  const beforeUpdate = countLog(env, 'update');
  const beforeRemove = countLog(env, 'removeAll');
  env.exts.find((e) => e.id === 'ext-aaaa').enabled = false;
  env.fire('mgmtOnDisabled', { ...aaaa(), enabled: false }); // 退避窗口内的增量更新
  await SLEEP(20);
  check('J1 退避窗口内增量更新被跳过（无 update 调用）', countLog(env, 'update') === beforeUpdate, `update=${countLog(env, 'update')}`);
  check('J4 未误触发降级全量刷新', await waitFor(() => menusCorrect(env), 5000) && countLog(env, 'removeAll') === beforeRemove + 1,
    `removeAll=${countLog(env, 'removeAll')}`);
  check('J2 重建后标题为新状态', env.menus.get('toggle-ext-aaaa')?.title === '🌑 A&&B Tools', env.menus.get('toggle-ext-aaaa')?.title);
  check('J3 菜单完整且无重复 id', menusCorrect(env) && env.errors.every((e) => !e.startsWith('create')));
}

// ---- 幽灵项检测（storage.local 清单比对）----
function seedConsistent(extraGhosts) {
  return ({ menus: m, exts: xs }) => {
    m.set('terminal-root', { id: 'terminal-root', title: '扩展管家' });
    for (const e of xs.filter((x) => x.id !== 'self-id' && x.type === 'extension' && x.mayDisable !== false)) {
      m.set(`toggle-${e.id}`, { id: `toggle-${e.id}`, title: expectedTitle(e), parentId: 'terminal-root' });
    }
    m.set('disable-all', { id: 'disable-all', title: '🚫 一键关闭所有扩展', parentId: 'terminal-root' });
    for (const g of extraGhosts || []) m.set(g.id, { id: g.id, title: g.title, parentId: 'terminal-root' });
  };
}

async function testK_ghostDetectionViaManifest() {
  const shared = new Map();
  const env1 = makeEnv({ storageData: shared });
  currentEnv = env1;
  await waitFor(() => menusCorrect(env1) && !env1.swState.isRefreshing, 5000);
  check('K1 首次全量刷新后清单落盘',
    JSON.stringify([...(shared.get('menuManifest') || [])].sort()) === JSON.stringify([...expectedKeys(env1)].sort()),
    JSON.stringify(shared.get('menuManifest')));

  // 模拟禁用窗口期：ext-bbbb 被卸载且错过 onUninstalled（SW 已死），菜单残留幽灵项。
  // 探测法只探测"应存在"的项、发现不了多余项；只有清单比对能发现。
  const exts2 = env1.exts.filter((e) => e.id !== 'ext-bbbb').map((e) => ({ ...e }));
  const env2 = makeEnv({
    exts: exts2,
    storageData: shared, // 清单跨"SW 重启"保留
    seed: seedConsistent([{ id: 'toggle-ext-bbbb', title: '🌑 禅模式' }]),
  });
  currentEnv = env2;
  // 结束信号：清单被重写为新预期（只会在清单比对触发的新刷新成功后发生）
  const expected2 = [...expectedKeys(env2)].sort().join('\n');
  check('K2 幽灵菜单项被清单比对发现并清除',
    await waitFor(() => (shared.get('menuManifest') || []).slice().sort().join('\n') === expected2, 5000) &&
    !env2.menus.has('toggle-ext-bbbb') && menusCorrect(env2));
  check('K3 幽灵清理恰好一次全量刷新', countLog(env2, 'removeAll') === 1, `removeAll=${countLog(env2, 'removeAll')}`);
  check('K4 清单已同步更新',
    JSON.stringify([...(shared.get('menuManifest') || [])].sort()) === JSON.stringify([...expectedKeys(env2)].sort()),
    JSON.stringify(shared.get('menuManifest')));
}

async function testL_matchingManifestProbePath() {
  const shared = new Map();
  const env1 = makeEnv({ storageData: shared });
  currentEnv = env1;
  await waitFor(() => menusCorrect(env1) && !env1.swState.isRefreshing, 5000);
  // 模拟 SW 重启：菜单仍在（contextMenus 持久化）、清单一致 → 应走探测路径零重建
  const env2 = makeEnv({ exts: env1.exts.map((e) => ({ ...e })), storageData: shared, seed: seedConsistent() });
  currentEnv = env2;
  await SLEEP(400); // 负向断言：探测无错误时不可能触发刷新
  check('L1 清单一致时走探测路径零重建', countLog(env2, 'removeAll') === 0 && menusCorrect(env2), `removeAll=${countLog(env2, 'removeAll')}`);
  check('L2 对账探测执行（根+4 项+一键关闭）', countLog(env2, 'update') === 6, `update=${countLog(env2, 'update')}`);
}

async function testM_storageFailureFallsBackToProbe() {
  const env = makeEnv();
  currentEnv = env;
  env.flags.failStorageGet = 1; // 清单读取失败
  check('M1 存储故障时退化为纯探测路径，功能完好',
    await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000));
  check('M2 探测发现菜单缺失后照常触发一次全量刷新', countLog(env, 'removeAll') === 1, `removeAll=${countLog(env, 'removeAll')}`);
}

// ---- 一键关闭全部扩展 ----
async function testN_disableAllFlow() {
  const env = makeEnv();
  currentEnv = env;
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000);
  const beforeSet = countLog(env, 'setEnabled');
  env.listeners.cmOnClicked[0]({ menuItemId: 'disable-all' });
  check('N1 所有已启用的可管理扩展被禁用',
    await waitFor(() => manageable(env).every((e) => !e.enabled), 3000),
    JSON.stringify(manageable(env).map((e) => `${e.name}:${e.enabled}`)));
  check('N2 仅对已启用项调用 setEnabled（3 次，已禁用的不重复处理）',
    countLog(env, 'setEnabled') === beforeSet + 3, `setEnabled=${countLog(env, 'setEnabled')}`);
  const expectOrder = expectedKeys(env).join(',');
  check('N3 一键关闭后菜单全部为 🌑 且按禁用组顺序重建',
    await waitFor(() => [...env.menus.keys()].join(',') === expectOrder, 5000),
    [...env.menus.keys()].join(','));
  check('N4 一键关闭项保留在菜单末尾',
    env.menus.get('disable-all')?.title === '🚫 一键关闭所有扩展' &&
    [...env.menus.keys()].pop() === 'disable-all');
}

// ---- 后台持续播放开关 ----
async function testO_keepAliveToggle() {
  const env = makeEnv();
  currentEnv = env;
  env.storageData.set('keepAlive', true); // 模拟 popup 写入开关
  env.fire('storageOnChanged', { keepAlive: { newValue: true } }, 'local');
  check('O1 开启后注册 MAIN world 脚本',
    await waitFor(() => env.registered.some((s) => s.id === 'keep-alive' && s.world === 'MAIN' && s.runAt === 'document_start'), 3000),
    JSON.stringify(env.registered));
  check('O2 已打开标签立即注入',
    await waitFor(() => env.injections.some((i) => i.files?.[0] === 'keepAlive.js' && i.world === 'MAIN'), 3000),
    JSON.stringify(env.injections));
  check('O3 注册脚本覆盖全部站点与子框架',
    env.registered[0]?.matches?.[0] === '<all_urls>' && env.registered[0]?.allFrames === true);

  const before = env.injections.length;
  env.fire('storageOnChanged', { keepAlive: { newValue: false } }, 'local');
  check('O4 关闭后注销脚本',
    await waitFor(() => !env.registered.some((s) => s.id === 'keep-alive'), 3000),
    JSON.stringify(env.registered));
  check('O5 关闭时注入撤销函数还原页面',
    await waitFor(() => env.injections.length > before && typeof env.injections.at(-1).func === 'function', 3000));
  check('O6 开关不影响扩展菜单', await waitFor(() => menusCorrect(env), 3000));
}

// ---- 状态记忆与重装恢复 ----
async function testP_stateMemory() {
  const env = makeEnv();
  currentEnv = env;
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000);
  const target = env.exts.find((e) => e.id === 'ext-cccc');
  target.enabled = false;
  env.fire('mgmtOnDisabled', { ...target }); // 用户禁用该扩展
  check('P1 禁用状态写入 JSON 快照',
    await waitFor(() => env.storageData.get('stateMemory')?.['ext-cccc']?.enabled === false, 3000),
    JSON.stringify(env.storageData.get('stateMemory')));

  // 模拟“重装/重新导入扩展”：Chrome 把它带回启用态
  target.enabled = true;
  env.fire('mgmtOnInstalled', { ...target });
  check('P2 重装后按记忆自动恢复为禁用', await waitFor(() => target.enabled === false, 3000));
  check('P3 恢复后菜单同步为 🌑',
    await waitFor(() => env.menus.get('toggle-ext-cccc')?.title === '🌑 Item 10', 5000),
    env.menus.get('toggle-ext-cccc')?.title);
}

// ---- 云端快照在首次加载时生效 ----
async function testQ_presetFromCloud() {
  const preset = { 'ext-aaaa': { name: 'A&B Tools', enabled: false, ts: 1 } };
  const env = makeEnv({
    storageData: new Map([['cloudConfig', { url: 'https://worker.test', token: 'tk' }]]),
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(preset) }),
  });
  currentEnv = env;
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000);
  env.fire('rtOnInstalled', { reason: 'install' });
  check('Q1 首次加载按云端快照恢复为禁用',
    await waitFor(() => env.exts.find((e) => e.id === 'ext-aaaa').enabled === false, 5000));
  check('Q2 恢复后菜单同步为 🌑',
    await waitFor(() => env.menus.get('toggle-ext-aaaa')?.title === '🌑 A&&B Tools', 5000),
    env.menus.get('toggle-ext-aaaa')?.title);
  check('Q3 预设已写入记忆快照',
    await waitFor(() => env.storageData.get('stateMemory')?.['ext-aaaa']?.enabled === false, 3000),
    JSON.stringify(env.storageData.get('stateMemory')));
}

// ---- 卸载后清除记忆记录 ----
async function testR_forgetOnUninstall() {
  const env = makeEnv();
  currentEnv = env;
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000);
  const target = env.exts.find((e) => e.id === 'ext-dddd');
  target.enabled = false;
  env.fire('mgmtOnDisabled', { ...target });
  check('R0 禁用状态先写入记忆',
    await waitFor(() => env.storageData.get('stateMemory')?.['ext-dddd']?.enabled === false, 3000),
    JSON.stringify(env.storageData.get('stateMemory')));

  env.exts.splice(env.exts.findIndex((e) => e.id === 'ext-dddd'), 1);
  env.fire('mgmtOnUninstalled', 'ext-dddd');
  check('R1 卸载后对应 ID 被标记为墓碑（删除可同步、不被旧快照复活）',
    await waitFor(() => (env.storageData.get('stateMemory') || {})['ext-dddd']?.deleted === true, 3000),
    JSON.stringify(env.storageData.get('stateMemory')));
  check('R2 菜单中该扩展项被清除',
    await waitFor(() => !env.menus.has('toggle-ext-dddd') && menusCorrect(env), 5000),
    [...env.menus.keys()].join(','));
}

// ---- 云端自动推送 ----
async function testS_cloudAutoPush() {
  const calls = [];
  const env = makeEnv({
    storageData: new Map([['cloudConfig', { url: 'https://worker.test', token: 'tk' }]]),
    fetch: (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET' });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    },
  });
  currentEnv = env;
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000);
  const target = env.exts.find((e) => e.id === 'ext-aaaa');
  target.enabled = false;
  env.fire('mgmtOnDisabled', { ...target });
  check('S1 状态变化后自动 PUT 到云端',
    await waitFor(() => calls.some((c) => c.method === 'PUT' && c.url === 'https://worker.test/state'), 8000),
    JSON.stringify(calls));
  check('S2 推送携带记忆快照', (env.storageData.get('stateMemory') || {})['ext-aaaa']?.enabled === false,
    JSON.stringify(env.storageData.get('stateMemory')));
}

// ---- 用户在启用确认框中取消 ----
async function testT_userDeclinesEnable() {
  const env = makeEnv({
    exts: [
      { id: 'ext-aaaa', name: 'A&B Tools', enabled: false, type: 'extension', mayDisable: true },
      { id: 'self-id', name: '扩展管家', enabled: true, type: 'extension', mayDisable: true },
    ],
    storageData: new Map([['stateMemory', { 'ext-aaaa': { name: 'A&B Tools', enabled: true, ts: 1 } }]]),
  });
  env.flags.declineEnable = 1;
  currentEnv = env;
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000);
  env.fire('mgmtOnInstalled', env.exts.find((e) => e.id === 'ext-aaaa'));
  check('T1 用户取消后扩展保持禁用',
    await waitFor(() => env.exts.find((e) => e.id === 'ext-aaaa').enabled === false, 4000));
  check('T2 记忆被改写为真实状态（避免反复弹框）',
    await waitFor(() => env.storageData.get('stateMemory')?.['ext-aaaa']?.enabled === false, 4000),
    JSON.stringify(env.storageData.get('stateMemory')));
  check('T3 不重复尝试启用', countLog(env, 'setEnabled') === 1, `setEnabled=${countLog(env, 'setEnabled')}`);
}

// ---- 墓碑跨设备传播：旧云端快照不得复活已删除记录 ----
async function testU_tombstoneBeatsOldCloud() {
  // 云端是另一台设备尚未同步的旧记录（ts 小、无 deleted），本地墓碑 ts 更新
  const oldRemote = { 'ext-aaaa': { name: 'A&B Tools', enabled: true, ts: 1 } };
  const mem = new Map([
    ['cloudConfig', { url: 'https://worker.test', token: 'tk' }],
    ['stateMemory', { 'ext-aaaa': { name: 'A&B Tools', enabled: true, deleted: true, ts: 9999999999999 } }],
  ]);
  const env = makeEnv({
    storageData: mem,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(oldRemote) }),
  });
  currentEnv = env;
  await waitFor(() => menusCorrect(env) && !env.swState.isRefreshing, 5000);
  env.fire('rtOnInstalled', { reason: 'install' }); // 触发 initMemoryState 拉取合并
  check('U1 旧云端快照不复活本地墓碑',
    await waitFor(() => env.storageData.get('stateMemory')?.['ext-aaaa']?.deleted === true, 5000),
    JSON.stringify(env.storageData.get('stateMemory')));
  check('U2 墓碑条目不显示缺失提醒',
    ![...env.menus.keys()].some((k) => k.includes('missing')), [...env.menus.keys()].join(','));
}

// ---- 运行 ----
(async () => {
  const tests = [
    testA_coldBootReconcile, testB_reconcileConsistent, testB2_reconcileSyncsStaleTitle,
    testC_clickToggleFlow, testC2_toggleTailKeepsOrder, testD_updateDuringRefreshDeferred, testE_retryBackoffAndRecovery,
    testF_syncThrowDoesNotDeadlock, testG_rapidEventsDedup, testH_emptyListPlaceholder,
    testI_getAllFailureRetries, testJ_updateSkippedInBackoffWindow,
    testK_ghostDetectionViaManifest, testL_matchingManifestProbePath, testM_storageFailureFallsBackToProbe,
    testN_disableAllFlow, testO_keepAliveToggle, testP_stateMemory, testQ_presetFromCloud,
    testR_forgetOnUninstall, testS_cloudAutoPush, testT_userDeclinesEnable, testU_tombstoneBeatsOldCloud,
  ];
  for (const t of tests) {
    try { await t(); } catch (e) { check(t.name + ' 抛异常', false, e.stack || e.message); }
  }
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  → ' + r.extra}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})();
