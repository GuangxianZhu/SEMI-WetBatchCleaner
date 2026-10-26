// 生成器小工具：一个动作写成一个生成器，每 yield 一次消耗一个时间步，next(dt) 把 dt 传进去。
// 主控的计划、子控的作业都用这个写法。

export function* waitS(s) { let t = 0; while (t < s) t += yield; }
export function* until(fn, maxS = Infinity) { let t = 0; while (!fn()) { if (t >= maxS) return false; t += yield; } return true; }
export function* anim(obj, key, target, dur) {
  const v0 = obj[key];
  let t = 0;
  while (t < dur) { t += yield; obj[key] = v0 + (target - v0) * Math.min(1, t / dur); }
  obj[key] = target;
}
// 几件事同时进行，全部做完才往下走
export function* par(...gens) {
  const live = gens.map(g => ({ g, done: false }));
  let dt = 0;
  for (;;) {
    for (const s of live) if (!s.done && s.g.next(dt).done) s.done = true;
    if (live.every(s => s.done)) return;
    dt = yield;
  }
}
