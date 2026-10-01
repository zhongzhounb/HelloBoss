// ==UserScript==
// @name         BOSS直聘控制台解锁
// @namespace    local.codex.zhipin
// @version      0.1.0
// @description  Keep DevTools usable on zhipin.com pages for local JavaScript debugging.
// @match        https://www.zhipin.com/*
// @match        https://m.zhipin.com/*
// @match        https://*.zhipin.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 基础标识与调试开关。DEBUG 默认关闭，避免脚本本身污染控制台输出。
  const TAG = '[zhipin-devtools-unlock]';
  const VERSION = '0.1.0';
  const DEBUG = false;

  // 记录脚本注入时间和页面状态，方便后续判断是否被刷新循环或反调试逻辑打断。
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const startedReadyState = document.readyState;

  // 在 document-start 阶段先保存原生方法引用，后续打补丁时始终回落到这些原始实现。
  const rawAddEventListener = EventTarget.prototype.addEventListener;
  const rawPreventDefault = Event.prototype.preventDefault;
  const rawStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
  const rawOpen = window.open;
  const rawClose = window.close;
  const rawHistoryBack = history.back;
  const rawHistoryGo = history.go;
  const rawDocumentCreateElement = Document.prototype.createElement;
  const rawNodeAppendChild = Node.prototype.appendChild;
  const rawNodeInsertBefore = Node.prototype.insertBefore;
  const rawFunctionToString = Function.prototype.toString;

  // WeakMap/WeakSet 用来记录已伪装或已 patch 的对象，防止重复包裹导致行为异常。
  const nativeFunctionSources = new WeakMap();
  const patchedConsoles = new WeakSet();
  const patchedTimers = new WeakSet();
  const patchedLocationTargets = new WeakSet();
  const reportedLocationRealms = new WeakSet();

  // 记录短时间内的跳转尝试，用来识别站点反调试触发的刷新/跳转循环。
  const navigationAttempts = [];

  // 暴露给页面控制台的诊断状态。可以在控制台查看 window.__zhipinDevtoolsUnlock。
  const status = {
    version: VERSION,
    startedAt,
    startedReadyState,
    startedHref: '',
    marks: [],
    blockedNavigations: [],
    consoleClearsBlocked: 0,
  };

  try {
    status.startedHref = location.href;
    Object.defineProperty(window, '__zhipinDevtoolsUnlock', {
      configurable: true,
      value: status,
    });
  } catch (_) {}

  // 统一记录关键节点。marks 只保留最近 100 条，避免诊断信息本身无限增长。
  function mark(name, detail) {
    try {
      const entry = Object.assign({
        name,
        t: typeof performance !== 'undefined' ? performance.now() : Date.now(),
        readyState: document.readyState,
        href: location.href,
      }, detail || {});

      status.marks.push(entry);
      if (status.marks.length > 100) status.marks.shift();
    } catch (_) {}
  }

  mark('script-start');

  // 生成当前页面的“刷新循环判断键”。去掉 hash，并弱化常见安全校验/时间戳参数。
  function reloadLoopKey() {
    try {
      const url = new URL(location.href);
      url.hash = '';
      url.search = url.search
        .replace(/([?&]_security_check=)[^&]*/g, '$1*')
        .replace(/([?&]_=)\d+/g, '$1*');
      return url.href;
    } catch (_) {
      return location.href.split('#')[0];
    }
  }

  // 如果同一页面在很短时间内反复启动，通常是反调试逻辑在刷新页面，这里尝试 window.stop() 止血。
  function detectRefreshLoop() {
    try {
      const now = Date.now();
      const key = reloadLoopKey();
      const storageKey = '__zhipin_devtools_unlock_nav_starts__';
      const entries = JSON.parse(sessionStorage.getItem(storageKey) || '[]')
        .filter((entry) => now - entry.t < 10000);

      entries.push({ t: now, key });
      sessionStorage.setItem(storageKey, JSON.stringify(entries.slice(-30)));

      const sameUrlStarts = entries.filter((entry) => entry.key === key).length;
      status.refreshLoop = { key, sameUrlStarts, windowMs: 10000 };

      if (sameUrlStarts >= 4) {
        mark('refresh-loop-suspected', { key, sameUrlStarts });
        try {
          window.stop();
          status.refreshLoop.stopped = true;
          mark('refresh-loop-window-stop', { key, sameUrlStarts });
        } catch (_) {}
      }
    } catch (_) {}
  }

  detectRefreshLoop();

  // 记录页面生命周期事件，用于排查脚本是否足够早注入、DOM 是否正常加载。
  try {
    rawAddEventListener.call(document, 'readystatechange', function () {
      mark('readystatechange', { state: document.readyState });
    }, true);
    rawAddEventListener.call(window, 'DOMContentLoaded', function () {
      mark('domcontentloaded');
    }, true);
    rawAddEventListener.call(window, 'load', function () {
      mark('load');
    }, true);
  } catch (_) {}

  // 将包裹后的函数伪装成原生函数，降低站点通过 Function#toString 检测 monkey patch 的概率。
  function markNative(wrapper, nativeFunction) {
    let source = '';

    try {
      if (nativeFunctionSources.has(nativeFunction)) {
        source = nativeFunctionSources.get(nativeFunction);
      }
    } catch (_) {}

    try {
      if (!source) source = rawFunctionToString.call(nativeFunction);
    } catch (_) {}

    try {
      if (!/\[native code\]/.test(source)) {
        const name = (nativeFunction && nativeFunction.name) || wrapper.name || '';
        source = name
          ? 'function ' + name + '() { [native code] }'
          : 'function () { [native code] }';
      }

      nativeFunctionSources.set(wrapper, source);
    } catch (_) {}

    try {
      Object.defineProperty(wrapper, 'toString', {
        configurable: true,
        value: function toString() {
          return source || 'function () { [native code] }';
        },
      });
    } catch (_) {}

    return wrapper;
  }

  // 接管 Function#toString：对已登记的包装函数返回原函数源码或 native code 外观。
  Function.prototype.toString = markNative(function toString() {
    try {
      if (
        (typeof this === 'function' || (typeof this === 'object' && this !== null)) &&
        nativeFunctionSources.has(this)
      ) {
        return nativeFunctionSources.get(this);
      }
    } catch (_) {}

    return rawFunctionToString.call(this);
  }, rawFunctionToString);

  // 本脚本自己的调试输出入口，默认不会打印。
  function debug() {
    if (!DEBUG) return;

    try {
      const args = Array.prototype.slice.call(arguments);
      Function.prototype.apply.call(console.debug, console, [TAG].concat(args));
    } catch (_) {}
  }

  // 统计并节流记录 console.clear() 被拦截的次数。
  function noteConsoleClearBlocked(source) {
    try {
      status.consoleClearsBlocked += 1;
      if (status.consoleClearsBlocked <= 5 || status.consoleClearsBlocked % 20 === 0) {
        mark('console-clear-blocked', {
          source: source || 'unknown',
          count: status.consoleClearsBlocked,
        });
      }
    } catch (_) {}
  }

  // 获取当前调用栈。站点反调试逻辑通常可通过压缩函数名或文件名特征识别。
  function stackText() {
    try {
      return String(new Error().stack || '');
    } catch (_) {
      return '';
    }
  }

  // BOSS 直聘反调试逻辑中出现过的函数名/调用栈特征。
  function isAntiDebugStack(stack) {
    return /\b(Bm|XCID|jf|Ef|Qm)\b|onDevToolOpen|no-debug|main\.js:1:66\d{4,}/i.test(stack || stackText());
  }

  // 更宽泛的站点安全脚本特征，用于判断某次跳转是否来自可疑安全逻辑。
  function isKnownZhipinSecurityStack(stack) {
    return /zhipin|security|no-debug|main\.js|vendor-1|app~3|f5694d3d/i.test(stack || stackText());
  }

  // 将相对地址标准化成绝对 URL，便于和当前页面地址或历史记录做比较。
  function normalizeNavigationTarget(url) {
    if (url == null) return '';

    const raw = String(url).trim();
    if (!raw) return '';

    try {
      return new URL(raw, location.href).href;
    } catch (_) {
      return raw;
    }
  }

  // 记录被拦截的导航行为，方便在控制台状态对象里回看原因和调用栈摘要。
  function rememberBlockedNavigation(reason, url, stack) {
    try {
      const entry = {
        reason,
        url: String(url == null ? '' : url).slice(0, 500),
        t: Date.now(),
        readyState: document.readyState,
        href: location.href,
        stack: String(stack || '').slice(0, 800),
      };

      status.blockedNavigations.push(entry);
      if (status.blockedNavigations.length > 50) status.blockedNavigations.shift();
      mark('blocked-navigation', { reason, url: entry.url });
    } catch (_) {}
  }

  // 判断 location.assign/replace/window.open 等导航是否应该被阻止。
  function shouldBlockNavigation(url, method) {
    const raw = String(url == null ? '' : url).trim();
    const stack = stackText();

    if (!raw || raw === 'about:blank') {
      rememberBlockedNavigation(method + ':empty-url', raw, stack);
      return true;
    }

    const target = normalizeNavigationTarget(raw);
    const now = Date.now();

    navigationAttempts.push({ t: now, target, method });
    while (navigationAttempts.length && now - navigationAttempts[0].t > 5000) {
      navigationAttempts.shift();
    }

    const sameTargetCount = navigationAttempts.filter((entry) => entry.target === target).length;
    const sameDocument = target === location.href;

    if ((sameDocument || sameTargetCount >= 3) && isKnownZhipinSecurityStack(stack)) {
      rememberBlockedNavigation(method + ':loop', raw, stack);
      return true;
    }

    return false;
  }

  // 判断 location.reload 是否属于反调试触发的刷新循环。
  function shouldBlockReload(method) {
    const stack = stackText();
    const now = Date.now();
    const target = location.href;

    navigationAttempts.push({ t: now, target, method });
    while (navigationAttempts.length && now - navigationAttempts[0].t > 5000) {
      navigationAttempts.shift();
    }

    const sameReloadCount = navigationAttempts.filter((entry) => entry.target === target && entry.method === method).length;

    if (isAntiDebugStack(stack) || (sameReloadCount >= 2 && isKnownZhipinSecurityStack(stack))) {
      rememberBlockedNavigation(method + ':reload-loop', target, stack);
      return true;
    }

    return false;
  }

  // 安全地读取定时器回调源码；反调试代码常把危险行为藏在 setTimeout/setInterval 中。
  function callbackSource(callback) {
    try {
      if (typeof callback === 'function') return rawFunctionToString.call(callback);
      return String(callback || '');
    } catch (_) {
      return '';
    }
  }

  // 识别会清空/隐藏页面并触发跳转的反调试定时器，避免打开 DevTools 后进入内存炸弹或页面销毁分支。
  function isDestructiveAntiDebugTimeout(callback, delay) {
    const source = callbackSource(callback);
    const numericDelay = Number(delay);
    const hasLocation = /(?:window\.)?location/.test(source) || source.includes('`SBw[u>;');
    const hasNavigation = /href|reload|replace|assign/.test(source) || source.includes('`SBw[u>;');
    const clearsDocument = (
      source.includes('innerHTML') ||
      source.includes('`^R|[^ZeoaND') ||
      source.includes('appendChild') ||
      source.includes('display: none !important') ||
      source.includes('visibility: hidden !important') ||
      source.includes('opacity: 0 !important') ||
      source.includes('filter: blur')
    );

    if (hasLocation && hasNavigation && clearsDocument) return true;

    return (
      numericDelay >= 50 &&
      numericDelay <= 300 &&
      source.includes('window.location') &&
      source.includes('appendChild') &&
      source.includes('style') &&
      (
        source.includes('innerHTML') ||
        source.includes('`^R|[^ZeoaND') ||
        source.includes('XvFbvo')
      )
    );
  }

  // 包裹 setTimeout/setInterval，拦截已知破坏性反调试回调。
  function patchTimers(realm) {
    if (!realm || patchedTimers.has(realm)) return;
    patchedTimers.add(realm);

    let originalSetTimeout;
    let originalSetInterval;
    try {
      originalSetTimeout = realm.setTimeout;
      originalSetInterval = realm.setInterval;
    } catch (_) {
      return;
    }

    if (typeof originalSetTimeout === 'function') {
      const wrappedSetTimeout = markNative(function setTimeout(callback, delay) {
        if (isDestructiveAntiDebugTimeout(callback, delay)) {
          rememberBlockedNavigation('timer:destructive-timeout', 'setTimeout', stackText());
          debug('blocked destructive anti-debug timeout');
          return 0;
        }

        return originalSetTimeout.apply(this, arguments);
      }, originalSetTimeout);

      try {
        realm.setTimeout = wrappedSetTimeout;
      } catch (_) {}
    }

    if (typeof originalSetInterval === 'function') {
      const wrappedSetInterval = markNative(function setInterval(callback, delay) {
        if (isDestructiveAntiDebugTimeout(callback, delay)) {
          rememberBlockedNavigation('timer:destructive-interval', 'setInterval', stackText());
          debug('blocked destructive anti-debug interval');
          return 0;
        }

        return originalSetInterval.apply(this, arguments);
      }, originalSetInterval);

      try {
        realm.setInterval = wrappedSetInterval;
      } catch (_) {}
    }

    mark('timers-patched');
  }

  // 替换目标对象上的原生方法，并保持 toString 外观接近原生实现。
  function replaceNativeMethod(target, name, wrapperFactory) {
    if (!target || patchedLocationTargets.has(target[name])) return false;

    let descriptor;

    try {
      descriptor = Object.getOwnPropertyDescriptor(target, name);
    } catch (_) {
      return false;
    }

    if (!descriptor || typeof descriptor.value !== 'function') return false;
    if (!descriptor.configurable && !descriptor.writable) return false;

    const original = descriptor.value;
    const wrapped = markNative(wrapperFactory(original), original);

    try {
      Object.defineProperty(target, name, Object.assign({}, descriptor, { value: wrapped }));
      patchedLocationTargets.add(wrapped);
      return true;
    } catch (_) {
      try {
        target[name] = wrapped;
        patchedLocationTargets.add(wrapped);
        return true;
      } catch (__) {
        return false;
      }
    }
  }

  // 接管 Location 原型方法，拦截反调试脚本常用的 assign/replace/reload。
  function patchLocationMethods(realm) {
    try {
      const proto = realm.Location && realm.Location.prototype;
      let patched = 0;

      patched += replaceNativeMethod(proto, 'assign', function (original) {
        return function assign(url) {
          if (shouldBlockNavigation(url, 'location.assign')) return undefined;
          return original.apply(this, arguments);
        };
      }) ? 1 : 0;

      patched += replaceNativeMethod(proto, 'replace', function (original) {
        return function replace(url) {
          if (shouldBlockNavigation(url, 'location.replace')) return undefined;
          return original.apply(this, arguments);
        };
      }) ? 1 : 0;

      patched += replaceNativeMethod(proto, 'reload', function (original) {
        return function reload() {
          if (shouldBlockReload('location.reload')) return undefined;
          return original.apply(this, arguments);
        };
      }) ? 1 : 0;

      if (!reportedLocationRealms.has(realm)) {
        reportedLocationRealms.add(realm);
        mark(patched ? 'location-methods-patched' : 'location-methods-unpatchable', { patched });
      }
    } catch (_) {}
  }

  patchTimers(window);
  patchLocationMethods(window);
  mark('critical-patches-installed');

  // 判断节点是否为 iframe。iframe 有自己的 window/console/timer/location，需要单独打补丁。
  function isIframeElement(node) {
    try {
      return node && node.tagName && String(node.tagName).toLowerCase() === 'iframe';
    } catch (_) {
      return false;
    }
  }

  // 对 iframe 的独立 realm 应用同一套防护；跨域 iframe 访问失败时直接忽略。
  function patchIframeRealm(iframe, reason) {
    if (!isIframeElement(iframe)) return;

    try {
      const realm = iframe.contentWindow;
      if (!realm) return;

      patchRealm(realm, { muteLogTable: true, realmName: 'iframe' });
      mark('iframe-realm-patched', { reason });
    } catch (_) {}
  }

  // iframe 的 contentWindow 可能延迟可用，所以同步、微任务、宏任务各尝试一次。
  function scheduleIframePatch(iframe, reason) {
    if (!isIframeElement(iframe)) return;

    patchIframeRealm(iframe, reason + ':sync');

    try {
      Promise.resolve().then(function () {
        patchIframeRealm(iframe, reason + ':microtask');
      });
    } catch (_) {}

    try {
      setTimeout(function () {
        patchIframeRealm(iframe, reason + ':timeout');
      }, 0);
    } catch (_) {}
  }

  // 捕获新创建的 iframe，尽早给其内部环境安装补丁。
  Document.prototype.createElement = markNative(function createElement(tagName, options) {
    const element = rawDocumentCreateElement.apply(this, arguments);

    if (String(tagName || '').toLowerCase() === 'iframe') {
      scheduleIframePatch(element, 'createElement');
    }

    return element;
  }, rawDocumentCreateElement);

  // 捕获插入 DOM 的 iframe，处理先创建后挂载的情况。
  Node.prototype.appendChild = markNative(function appendChild(node) {
    const result = rawNodeAppendChild.apply(this, arguments);

    if (isIframeElement(node)) {
      scheduleIframePatch(node, 'appendChild');
    }

    return result;
  }, rawNodeAppendChild);

  // 捕获通过 insertBefore 插入的 iframe，补齐另一种常见挂载方式。
  Node.prototype.insertBefore = markNative(function insertBefore(node, child) {
    const result = rawNodeInsertBefore.apply(this, arguments);

    if (isIframeElement(node)) {
      scheduleIframePatch(node, 'insertBefore');
    }

    return result;
  }, rawNodeInsertBefore);

  mark('iframe-hooks-installed');

  // DevTools 常用快捷键：F12、Ctrl/Cmd+Shift+I/J/C、查看源码/保存等。
  function isDevToolsShortcut(event) {
    if (!event || event.type !== 'keydown') return false;
    const key = String(event.key || '').toLowerCase();
    const code = event.keyCode || event.which;

    return (
      code === 123 ||
      key === 'f12' ||
      ((event.ctrlKey || event.metaKey) && event.shiftKey && ['i', 'j', 'c'].includes(key)) ||
      ((event.ctrlKey || event.metaKey) && ['u', 's'].includes(key)) ||
      (event.metaKey && event.altKey && ['i', 'j', 'u'].includes(key))
    );
  }

  // 右键菜单和 DevTools 快捷键属于浏览器原生动作，不允许页面脚本拦截。
  function keepNativeAction(event) {
    return event && (event.type === 'contextmenu' || isDevToolsShortcut(event));
  }

  // 读取事件监听器源码，用于识别页面注册的反 DevTools 按键/右键处理器。
  function listenerSource(listener) {
    try {
      if (typeof listener === 'function') return Function.prototype.toString.call(listener);
      if (listener && typeof listener.handleEvent === 'function') {
        return Function.prototype.toString.call(listener.handleEvent);
      }
    } catch (_) {}
    return '';
  }

  // 识别会拦截 F12/keyCode/which 的 keydown 监听器。
  function isAntiDevToolsKeyListener(type, listener) {
    if (type !== 'keydown') return false;
    const source = listenerSource(listener);
    return (
      source.includes('preventDefault') &&
      source.includes('returnValue') &&
      (source.includes('123') || source.includes('keyCode') || source.includes('which'))
    );
  }

  // 识别禁止右键菜单的 contextmenu 监听器。
  function isContextMenuBlocker(type, listener) {
    if (type !== 'contextmenu') return false;
    const source = listenerSource(listener);
    return source.includes('preventDefault') || source.includes('returnValue') || source.includes('return false');
  }

  // 捕获阶段提前截断页面自己的拦截器，让浏览器默认行为继续执行。
  function stopPageHandlers(event) {
    if (keepNativeAction(event)) {
      rawStopImmediatePropagation.call(event);
    }
  }

  // 阻止页面注册已知反调试监听器，其他正常监听器仍按原逻辑注册。
  EventTarget.prototype.addEventListener = markNative(function addEventListener(type, listener, options) {
    if (isAntiDevToolsKeyListener(type, listener) || isContextMenuBlocker(type, listener)) {
      return undefined;
    }

    return rawAddEventListener.call(this, type, listener, options);
  }, rawAddEventListener);

  // 对 DevTools 快捷键和右键菜单，忽略页面调用 preventDefault() 的企图。
  Event.prototype.preventDefault = markNative(function preventDefault() {
    if (keepNativeAction(this)) return undefined;
    return rawPreventDefault.call(this);
  }, rawPreventDefault);

  // 有些代码通过 event.returnValue = false 禁止默认行为，这里同样放行原生动作。
  try {
    const returnValueDescriptor = Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue');

    if (returnValueDescriptor && returnValueDescriptor.configurable) {
      Object.defineProperty(Event.prototype, 'returnValue', {
        configurable: true,
        get() {
          return returnValueDescriptor.get ? returnValueDescriptor.get.call(this) : true;
        },
        set(value) {
          if (value === false && keepNativeAction(this)) return true;
          if (returnValueDescriptor.set) return returnValueDescriptor.set.call(this, value);
          return true;
        },
      });
    }
  } catch (_) {}

  // 在捕获阶段注册自己的保护监听器，尽量早于页面业务监听器生效。
  rawAddEventListener.call(window, 'keydown', stopPageHandlers, true);
  rawAddEventListener.call(window, 'contextmenu', stopPageHandlers, true);
  rawAddEventListener.call(document, 'keydown', stopPageHandlers, true);
  rawAddEventListener.call(document, 'contextmenu', stopPageHandlers, true);

  // 处理站点早期 body 探针：某些检测把 document.body 缺失视为原生方法被改，并进入大数组分配分支。
  (function patchEarlyBodyProbe() {
    try {
      const descriptor =
        Object.getOwnPropertyDescriptor(Document.prototype, 'body') ||
        Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'body');

      if (!descriptor || !descriptor.configurable || !descriptor.get) return;

      const fallbackBody = document.createElement('body');

      Object.defineProperty(document, 'body', {
        configurable: true,
        get() {
          const realBody = descriptor.get.call(this);
          if (realBody) return realBody;

          // Bm() 会把 body 缺失当成“原生方法被修改”，随后故意分配大数组。
          // 这里只在反调试调用栈里返回一个脱离文档的 body，让它走非 OOM 分支。
          if (isAntiDebugStack(stackText())) return fallbackBody;

          return realBody;
        },
        set(value) {
          if (descriptor.set) return descriptor.set.call(this, value);
          return undefined;
        },
      });
    } catch (_) {}
  })();

  // 判断 console 参数是否像反调试探针：RegExp/Date/function/大量数组/临时 DIV 等。
  function isProbeArgument(value) {
    try {
      const tag = Object.prototype.toString.call(value);
      if (tag === '[object RegExp]') return true;
      if (tag === '[object Date]') return true;
      if (typeof value === 'function') return true;
      if (Array.isArray(value) && value.length >= 20) return true;
      if (value && value.nodeType === 1 && String(value.tagName || '').toUpperCase() === 'DIV') return true;
    } catch (_) {}

    return false;
  }

  // 只静音来自站点安全脚本调用栈的 console 探针，避免影响正常业务日志。
  function shouldMuteConsoleProbe(args) {
    const stack = stackText();
    if (!/(zhipin|main\.js|security|no-debug)/i.test(stack)) return false;
    return args.some(isProbeArgument) || /(XCID|jf|Ef|Qm|onDevToolOpen)/.test(stack);
  }

  // 保护 console：阻止 clear 清屏，并按需静音 log/table 探针。
  function patchConsole(consoleObject, options) {
    if (!consoleObject || patchedConsoles.has(consoleObject)) return;
    patchedConsoles.add(consoleObject);
    const realmName = options && options.realmName || 'unknown';

    const originalDebug = typeof consoleObject.debug === 'function'
      ? consoleObject.debug.bind(consoleObject)
      : function () {};
    const originalClear = typeof consoleObject.clear === 'function'
      ? consoleObject.clear
      : function () {};
    const originalLog = typeof consoleObject.log === 'function'
      ? consoleObject.log
      : function () {};
    const originalTable = typeof consoleObject.table === 'function'
      ? consoleObject.table
      : function () {};

    try {
      Object.defineProperty(consoleObject, 'clear', {
        configurable: true,
        writable: true,
        value: markNative(function clear() {
          noteConsoleClearBlocked(realmName);
          debug('blocked console.clear()');
        }, originalClear),
      });
    } catch (_) {
      try {
        consoleObject.clear = markNative(function clear() {
          noteConsoleClearBlocked(realmName);
          debug('blocked console.clear()');
        }, originalClear);
      } catch (__) {}
    }

    if (options && options.muteLogTable) {
      try {
        consoleObject.log = markNative(function log() {}, originalLog);
        consoleObject.table = markNative(function table() {}, originalTable);
      } catch (_) {}
    } else if (options && options.guardLogTable) {
      try {
        consoleObject.log = markNative(function log() {
          const args = Array.prototype.slice.call(arguments);
          if (shouldMuteConsoleProbe(args)) return undefined;
          return originalLog.apply(consoleObject, args);
        }, originalLog);

        consoleObject.table = markNative(function table() {
          const args = Array.prototype.slice.call(arguments);
          if (shouldMuteConsoleProbe(args)) return undefined;
          return originalTable.apply(consoleObject, args);
        }, originalTable);
      } catch (_) {}
    }
  }

  // 对一个 window-like realm 统一安装 console/timer/location 防护。
  function patchRealm(realm, options) {
    if (!realm) return;
    try {
      patchConsole(realm.console, options);
    } catch (_) {}
    try {
      patchTimers(realm);
    } catch (_) {}
    try {
      patchLocationMethods(realm);
    } catch (_) {}
  }

  patchRealm(window, { muteLogTable: false, guardLogTable: true, realmName: 'window' });

  // BOSS 直聘部分安全逻辑会把独立 realm 挂到 __xbcw，这里在赋值瞬间补上防护。
  try {
    let xbcwRealm;

    Object.defineProperty(window, '__xbcw', {
      configurable: true,
      get() {
        return xbcwRealm;
      },
      set(value) {
        xbcwRealm = value;
        patchRealm(value, { muteLogTable: true, realmName: '__xbcw' });
      },
    });
  } catch (_) {}

  // 阻止 window.open('', '_self') 这类把当前页清空/替换的反调试手段。
  window.open = markNative(function open(url, target, features) {
    if ((url === '' || url == null) && target === '_self') {
      debug('blocked window.open("", "_self")');
      return null;
    }

    return rawOpen.apply(this, arguments);
  }, rawOpen);

  // 页面尝试自关闭时直接忽略，避免调试时标签页被关闭。
  window.close = markNative(function close() {
    debug('blocked window.close()');
    return undefined;
  }, rawClose);

  // 阻止反调试脚本把用户后退到上一页。
  history.back = markNative(function back() {
    debug('blocked history.back()');
    return undefined;
  }, rawHistoryBack);

  // 只拦截 history.go(-1)，其他历史跳转参数仍交给原生实现。
  history.go = markNative(function go(delta) {
    if (delta === -1) {
      debug('blocked history.go(-1)');
      return undefined;
    }

    return rawHistoryGo.apply(this, arguments);
  }, rawHistoryGo);

  // 防止反调试逻辑通过清空 body/html 的 innerHTML 直接销毁当前页面。
  try {
    const innerHTMLDescriptor =
      Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML') ||
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerHTML');

    if (innerHTMLDescriptor && innerHTMLDescriptor.configurable && innerHTMLDescriptor.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true,
        get() {
          return innerHTMLDescriptor.get.call(this);
        },
        set(value) {
          if ((this === document.body || this === document.documentElement) && value === '') {
            debug('blocked document body/html cleanup');
            return undefined;
          }

          return innerHTMLDescriptor.set.call(this, value);
        },
      });
    }
  } catch (_) {}

  // 移除会隐藏或模糊页面根节点的反调试样式。
  function removeAntiDebugStyles() {
    try {
      document.querySelectorAll('style').forEach(function (style) {
        const text = style.textContent || '';
        const targetsRoot = /\b(html|body|app)\b/.test(text);
        const hidesPage = /(filter:\s*blur\(20px\)|display:\s*none|visibility:\s*hidden|opacity:\s*0)/i.test(text);

        if (targetsRoot && hidesPage) {
          style.remove();
        }
      });

      if (document.documentElement) {
        if (/blur|hidden|opacity:\\s*0/i.test(document.documentElement.getAttribute('style') || '')) {
          document.documentElement.style.filter = 'none';
          document.documentElement.style.visibility = 'visible';
          document.documentElement.style.opacity = '1';
        }
      }

      if (document.body) {
        if (/blur|hidden|opacity:\\s*0/i.test(document.body.getAttribute('style') || '')) {
          document.body.style.filter = 'none';
          document.body.style.visibility = 'visible';
          document.body.style.opacity = '1';
        }
      }
    } catch (_) {}
  }

  // 注入兜底恢复样式，确保 html/body/app 不被 display:none、opacity:0 或 blur 隐藏。
  function installRestoreStyle() {
    if (!document.documentElement || document.getElementById('__zhipin_devtools_unlock_style__')) return;

    const style = document.createElement('style');
    style.id = '__zhipin_devtools_unlock_style__';
    style.textContent = [
      'html, body {',
      '  filter: none !important;',
      '  visibility: visible !important;',
      '  opacity: 1 !important;',
      '}',
      'body { display: block !important; }',
      'app {',
      '  filter: none !important;',
      '  display: block !important;',
      '  visibility: visible !important;',
      '  opacity: 1 !important;',
      '}',
    ].join('\n');

    document.documentElement.appendChild(style);
  }

  // 启动 DOM 守护：初次清理一次，并监听后续插入的可疑 style。
  function startDomGuards() {
    installRestoreStyle();
    removeAntiDebugStyles();

    try {
      const observer = new MutationObserver(function () {
        installRestoreStyle();
        removeAntiDebugStyles();
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (_) {}
  }

  if (document.documentElement) {
    startDomGuards();
  } else {
    rawAddEventListener.call(document, 'readystatechange', startDomGuards, true);
  }

  // 周期性重装关键补丁，防止页面安全脚本后续覆盖 console/timer/location 或再次注入隐藏样式。
  window.setInterval(function () {
    patchRealm(window, { muteLogTable: false, guardLogTable: true, realmName: 'window' });
    patchRealm(window.__xbcw, { muteLogTable: true, realmName: '__xbcw' });
    removeAntiDebugStyles();
  }, 500);

  debug('loaded');
})();
