// 让「大屏页面」成为这个服务的开关:页面开着服务就活着,页面关了服务自己退出。
//
// 为什么不是「页面定时打心跳」:浏览器会把后台标签页(最小化、或者切到 BOSS 直聘那页)
// 里的 setInterval 限流到大约每分钟一次,而用户干活时大屏恰恰就在后台 —— 靠轮询判断
// 「页面还在不在」会把正在干活的服务误杀。所以页面改成持有一条长连接(SSE,见
// server.js 的 /api/watch),由连接的开与断来驱动这里的记账。
//
// 本模块只管记账和定时(连接对象只当作一个带 end() 的句柄用),因此能用假定时器离线测。

export const DEFAULT_GRACE_MS = 60_000;
// 启动后迟迟没人连,说明这服务是白起的(旧进程没退干净、或者浏览器没打开),
// 那就别当孤儿进程赖着 —— 用户既看不见它,也没有正常手段关掉它。
export const DEFAULT_FIRST_GRACE_MS = 120_000;

/**
 * @param {object} options
 * @param {number} [options.graceMs]     最后一个连接断开后等多久才退出,用来容忍刷新与自动重连
 * @param {number} [options.firstGraceMs] 启动后一直没人连上时,等多久才退出
 * @param {() => void} options.onIdle    判定为「没人看了」时调用
 */
export function createIdleExit(options = {}) {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const firstGraceMs = options.firstGraceMs ?? DEFAULT_FIRST_GRACE_MS;
  const onIdle = options.onIdle || (() => {});

  // 用 Set 而不是计数:同一个连接重复注销、或者「注销没登记过的连接」,
  // Set 天然无副作用。计数法一旦被减到负数,就会永远等不到归零 ——
  // 表现为服务永久赖着不走,而用户完全看不出为什么。
  const live = new Set();
  let timer = null;   // 只在 live 为空时才有值
  let released = false; // releaseAll() 之后不再装任何定时器

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm(ms) {
    if (released) return;
    clearTimer();
    // 不变式:能走到这里 live 一定是空的 —— arm 只在「最后一个连接注销」和 start() 里
    // 被调用,而 add() 会立刻把定时器清掉。所以到点直接调 onIdle,不必再判一次;
    // 补一个 if 反而会掩盖「注销没配对」这种真问题。
    timer = setTimeout(() => {
      timer = null;
      onIdle();
    }, ms);
  }

  return {
    /** 启动时调用一次,给「页面还没连上」的一段宽限。 */
    start() {
      if (live.size === 0) arm(firstGraceMs);
    },

    /**
     * 登记一个新连接(SSE 的响应对象)。返回该连接的注销函数,断开时调一次即可;
     * 重复调用同一个注销函数是安全的。
     */
    add(connection) {
      live.add(connection);
      clearTimer();
      let done = false;
      return function release() {
        if (done) return;
        done = true;
        live.delete(connection);
        if (live.size === 0) arm(graceMs);
      };
    },

    /**
     * 退出前收尾:先停表(免得下面 end() 触发的断开又把定时器装上),再结束所有连接。
     * 结束连接是必要的 —— server.close() 会等长连接自己结束,不主动收尾就退不掉。
     */
    releaseAll() {
      released = true;
      clearTimer();
      for (const connection of live) {
        live.delete(connection);
        connection.end();
      }
    },

    /** 当前活着的连接数,给测试和日志用。 */
    count() {
      return live.size;
    },
  };
}
