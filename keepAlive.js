/**
 * 后台持续播放（MAIN world，document_start 注入）
 * 让页面始终认为自己是“可见且在前台”，避免切标签/切窗口时播放器主动暂停。
 * 开关关闭时由 background 注入调用 window.__butlerKeepAlive.disable() 还原。
 */
(() => {
  if (window.__butlerKeepAlive) return;

  const docProto = Document.prototype;
  const original = {
    hidden: Object.getOwnPropertyDescriptor(docProto, "hidden"),
    visibilityState: Object.getOwnPropertyDescriptor(docProto, "visibilityState")
  };

  Object.defineProperty(docProto, "hidden", { configurable: true, get: () => false });
  Object.defineProperty(docProto, "visibilityState", { configurable: true, get: () => "visible" });

  // window 捕获阶段掐断可见性事件，页面其余监听收不到 visibilitychange。
  // 说明：这是本功能的核心手段（播放器靠该事件暂停），会顺带影响同页其他脚本，属有意取舍。
  const block = (event) => event.stopImmediatePropagation();
  window.addEventListener("visibilitychange", block, true);

  // 只屏蔽窗口/文档级失焦；输入框等元素的 blur 不冒泡且 target 是元素，保持原样
  const blockBlur = (event) => {
    if (event.target === window || event.target === document) event.stopImmediatePropagation();
  };
  window.addEventListener("blur", blockBlur, true);

  window.__butlerKeepAlive = {
    disable() {
      delete window.__butlerKeepAlive;
      window.removeEventListener("visibilitychange", block, true);
      window.removeEventListener("blur", blockBlur, true);
      for (const [key, desc] of Object.entries(original)) {
        if (desc) Object.defineProperty(docProto, key, desc);
        else delete docProto[key];
      }
    }
  };
})();
