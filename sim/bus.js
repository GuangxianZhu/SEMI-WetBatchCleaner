// 主控 ↔ 子控的通信（docs/软件结构.md）。
// 真机：主控在 Windows PC（画面、配方、调度），子控在 Linux PC（搬送、各个槽的执行），中间走网络。
// 这里在同一个进程里，但规矩一样：
//   - 消息复制一份再送（structuredClone），双方不共享对象
//   - 主控 → 子控：cmd（做什么）；子控 → 主控：done（做完了）、alarm（报警）、event（过程记录）
//   - 子控每个时间步把自己的状态写进 status[地址]；主控要知道子控的情况，只看这里
// 现在消息立刻送到（延迟 0），和拆分之前的结果完全一样。

export class Bus {
  constructor(now = () => 0) {
    this.handlers = {};
    this.status = {};
    this.log = [];        // 最近的消息（画面上的通信记录用；过程记录 event 太多，不进这里）
    this.seq = 0;
    this.now = now;
  }
  on(addr, fn) { this.handlers[addr] = fn; }
  send(from, to, type, body = {}) {
    const msg = { id: ++this.seq, t: this.now(), from, to, type, body: structuredClone(body) };
    if (type !== 'event') { this.log.push(msg); if (this.log.length > 300) this.log.shift(); }
    const h = this.handlers[to];
    if (!h) throw new Error(`没有地址 ${to}`);
    h(msg);
    return msg.id;
  }
}
