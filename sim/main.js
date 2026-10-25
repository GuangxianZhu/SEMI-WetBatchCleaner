// 主控（docs/软件结构.md）：真机里跑在 Windows PC 上，负责"规划和调度"。
//   - 把配方（流程 → 单元 → 步骤）排成整批的工艺步骤（计划）
//   - 按计划给子控发命令、等子控回"做完了"
//   - 记录晶圆在哪（晶圆追踪）；交接之前用子控上报的状态检查跨模块的联锁（升降器到位没有、机械手在不在正上方、盖子开没开）
//   - 收报警、过程记录（给画面显示）
// 主控不碰设备，只看子控上报的状态（bus.status）。

import { P, TANKS, STATION_NAME } from './params.js';
import { BATHS, describeSteps, describeCond } from './recipe.js';
import { par } from './gen.js';

const NAME = STATION_NAME;

export class Main {
  constructor(L, bus) {
    this.L = L; this.bus = bus;
    this.doneIds = new Set();
    this.wafer = 'foup';            // 主控记录的晶圆位置（和机台上真实的位置应该一致）
    bus.on('main', m => this.receive(m));
  }
  receive(m) {
    const L = this.L, b = m.body;
    if (m.type === 'done') this.doneIds.add(b.of);
    else if (m.type === 'alarm') L.violate(b.msg);
    else if (m.type === 'event') {
      if (b.kind === 'stepStart') L.stepLog.push({ unit: b.unit, i: b.i, kind: b.step, t0: L.t, t1: null });
      if (b.kind === 'stepEnd') { const r = [...L.stepLog].reverse().find(x => x.unit === b.unit && x.i === b.i && x.t1 == null); if (r) r.t1 = L.t; }
      if (b.kind === 'rinse') L.rinseLog.push({ id: b.id, t: b.t, rho: b.rho });
      if (b.kind === 'note') L.notes.push(b.msg);
    }
  }
  send(to, cmd, args = {}) { return this.bus.send('main', to, 'cmd', { cmd, ...args }); }
  // 发命令、等做完
  *cmd(to, cmd, args) {
    const id = this.send(to, cmd, args);
    while (!this.doneIds.has(id)) yield;
    this.doneIds.delete(id);
  }
  // 发了不等（例如空升降器降回去）
  post(to, cmd, args) { this.send(to, cmd, args); }
  st(addr) { return this.bus.status[addr] || {}; }
  say(text) { this.L.phase = text; }

  // ---------- 搬送的编排 ----------
  // 交接（机械手 ↔ 升降器 / 姿态变换单元）：先用子控上报的状态查联锁，再让搬送子控张开 / 合上夹爪
  *handoff(from, to) {
    const L = this.L, stn = from === 'robot' ? to : from;
    const x = stn === 'posture' ? P.X.loader : P.X[stn];
    const nm = stn === 'posture' ? '姿态变换单元' : NAME[stn];
    const robot = this.st('transfer');
    if (Math.abs(robot.x - x) > 1e-3) L.violate(`交接时机械手不在${nm}正上方`);
    if (TANKS.includes(stn) && this.st(stn).lift < 0.999) L.violate(`交接时${nm}的升降器不在交接位置`);
    if (stn === 'dr' && this.st('dr').lid > 0.01) L.violate('减压干燥槽的盖子没开就交接');
    if (this.wafer !== from) L.violate('交接时晶圆不在交出的一方');
    const give = from === 'robot';
    if (!give) {
      if (robot.chem) L.violate(`夹爪上还沾着 ${robot.chem}，没洗就去接片`);
      if (stn === 'dr' && robot.wet) L.violate('夹爪是湿的，不能去取干片');
    }
    const b = BATHS[stn];
    yield* this.cmd('transfer', give ? 'PLACE' : 'PICK', { st: stn, nm, type: b ? b.type : 'loader', chem: b && b.kind });
    this.wafer = to;
  }
  // 放进槽里：升降器升到交接位置 → 交接 → 升降器下降
  *toTank(id) {
    this.say(`${NAME[id]}的升降器升到交接位置`);
    yield* this.cmd(id, 'LIFT', { z: 1 });
    yield* this.handoff('robot', id);
    this.say(`升降器下降，晶圆浸进${NAME[id]}`);
    yield* this.cmd(id, 'LIFT', { z: 0 });
  }
  // 从槽里取出：升降器提起（下一个槽的升降器同时先升到 0.85，晶圆在空气里的时间短）→ 交接 → 空升降器降回去
  *fromTank(id, nextId = null) {
    this.say(`升降器把晶圆提出${NAME[id]}`);
    if (nextId) yield* par(this.cmd(id, 'LIFT', { z: 1 }), this.cmd(nextId, 'LIFT', { z: 0.85 }));
    else yield* this.cmd(id, 'LIFT', { z: 1 });
    yield* this.handoff(id, 'robot');
    this.post(id, 'LIFT', { z: 0 });
  }
  // 带着晶圆去下一个槽；flow.airExtraS 模拟机械手半路被别的任务耽误
  *transferTo(id) {
    const x = P.X[id], extra = this.L.R.flow.airExtraS;
    if (extra > 0) {
      yield* this.cmd('transfer', 'MOVE', { x: (this.st('transfer').x + x) / 2, task: `移动到${NAME[id]}` });
      this.say(`机械手被别的任务耽误了 ${extra} s，晶圆一直在空气里`);
      yield* this.cmd('transfer', 'HOLD', { s: extra, task: `被别的任务耽误 ${extra} s` });
    }
    yield* this.cmd('transfer', 'MOVE', { x, task: `移动到${NAME[id]}` });
  }
  // 把晶圆从现在的位置搬进 bath：从装载区来，或者从上一个单槽来
  *bringTo(bath) {
    const h = this.wafer;
    if (h === 'posture') {
      this.say('槽间搬送机械手到装载区接批');
      yield* par(this.cmd('transfer', 'MOVE', { x: P.X.loader, task: '移动到装载区' }), this.cmd(bath, 'LIFT', { z: 0.85 }));
      yield* this.handoff('posture', 'robot');
      this.say(`送到${NAME[bath]}`);
      yield* this.cmd('transfer', 'MOVE', { x: P.X[bath], task: `移动到${NAME[bath]}` });
    } else if (TANKS.includes(h)) {
      this.say(`机械手到${NAME[h]}`);
      yield* this.cmd('transfer', 'MOVE', { x: P.X[h], task: `移动到${NAME[h]}` });
      yield* this.fromTank(h, bath);
      this.say(bath === 'dr' ? '尽快送到减压干燥槽' : `送到${NAME[bath]}`);
      yield* this.transferTo(bath);
    }
    yield* this.toTank(bath);
  }

  // 维护：药液槽换液（交给那个槽的子控做）
  *exchange(id) { yield* this.cmd(id, 'EXCHANGE'); }
}

// ---------- 计划：整批的工艺步骤 ----------
// 装载、取片、姿态变换、取出是固定的；中间按流程里的单元，一个槽一个步骤（sim/recipe.js）
const FIXED_HEAD = [
  {
    id: 'load', name: '晶圆盒到位、开门、映射', focus: 'loader',
    now: '两个 FOUP 放到装载口，FOUP 门和设备的门对接后一起打开，再逐个槽位扫描。',
    why: '先确认哪些槽位有片、有没有叠片或斜片，否则批量机械手一次取 25 片时会撞片。',
    *run(M) {
      M.say('两个 FOUP 放到装载口'); yield* M.cmd('loader', 'DOCK');
      M.say('FOUP 门和设备的门一起打开'); yield* M.cmd('loader', 'DOOR', { open: 1 });
      M.say('晶圆映射：逐个槽位扫描'); yield* M.cmd('loader', 'MAP');
    },
  },
  {
    id: 'pick', name: '批量取片、合批', focus: 'loader',
    now: '批量机械手一次从 FOUP 1 取出 25 片，再从 FOUP 2 取 25 片，交错插进去：两盒合成 50 片，间距从 10 mm 变成 5 mm。',
    why: '一片一片取太慢；合批（半间距）让一个槽一次洗 50 片，产能翻倍。代价是片间缝隙只剩约 4.2 mm，液流穿过片间更难。',
    *run(M) {
      M.say('批量机械手从 FOUP 1 一次取出 25 片'); yield* M.cmd('loader', 'TAKE', { n: 1 });
      M.say('再从 FOUP 2 取出 25 片，交错插进去'); yield* M.cmd('loader', 'TAKE', { n: 2 });
      M.wafer = 'posture';
    },
  },
  {
    id: 'posture', name: '姿态变换：水平 → 竖直', focus: 'loader',
    now: '整批晶圆从水平转成竖直。',
    why: '槽里的晶圆是竖着放的：液流从底部往上穿过片间，从溢流口流走；提出液面时水也能顺着往下流。',
    *run(M) { M.say('整批从水平转成竖直'); yield* M.cmd('loader', 'POSTURE', { to: 1 }); },
  },
];
const FIXED_TAIL = [
  {
    id: 'unload', name: '取出、转回水平、分回两个 FOUP', focus: 'loader',
    now: '机械手用干的夹爪从减压干燥槽取出干片，送回装载区；转回水平，分回两个 FOUP，关门。',
    why: '夹爪要先干燥：搬过单槽 2 的湿片以后夹爪是湿的，直接去取干片会把片边弄湿。每片晶圆都要回到原来 FOUP 的原来槽位（晶圆追踪）。',
    *run(M) {
      M.say('机械手到减压干燥槽');
      yield* M.cmd('transfer', 'MOVE', { x: P.X.dr, task: '移动到减压干燥槽' });
      yield* M.handoff('dr', 'robot');
      M.post('dr', 'LIFT', { z: 0 });
      M.say('送回装载区');
      yield* M.cmd('transfer', 'MOVE', { x: P.X.loader, task: '移动到装载区' });
      yield* M.handoff('robot', 'posture');
      M.say('整批从竖直转回水平'); yield* M.cmd('loader', 'POSTURE', { to: 0 });
      M.wafer = 'pick';
      M.say('分回 FOUP 2'); yield* M.cmd('loader', 'RETURN', { n: 2 });
      M.say('分回 FOUP 1'); yield* M.cmd('loader', 'RETURN', { n: 1 });
      M.wafer = 'foup';
      M.L.checkTracking();
      M.say('关门'); yield* M.cmd('loader', 'DOOR', { open: 0 });
    },
  },
];

// 每个单元为什么这样做（新人看的说明；按单元编号）
const UNIT_WHY = {
  spm: 'SPM 把有机物和光刻胶残留氧化分解掉。药液从内槽溢流到外槽，泵经加热器和过滤器打回内槽底部：表面一直在更新，颗粒被过滤器拦下。晶圆提出来时带着一层高温、高浓度的药液，在空气里待久了会局部变干，所以要马上进单槽。',
  rinse1: '快排前期稀释得快：每排一次只剩约 2 % 的残液；后期上流更稳，从底部进水、溢流带走。硫酸黏、难冲，所以先用热水。比电阻前面一直很低，到最后才猛地升上去：比电阻和离子浓度成反比，浓度按指数下降。',
  sc1: 'H₂O₂ 氧化表面、NH₄OH 慢慢溶掉氧化层，把颗粒从底下掏松；碱性下颗粒和硅表面都带负电，互相排斥，不容易再粘回去。兆声（约 1 MHz）帮忙把小颗粒冲走。代价：硅也被刻掉一点，表面变粗糙；SC1 还会让 Fe 沉积到表面。',
  dhf: '后面要在同一个槽里进 HF：槽里还有氨水的话，会生成 NH₄F，所以先把 SC1 冲干净。去掉 SC1 留下的化学氧化膜，表面变成 H 终端、疏水；嵌在氧化膜里的 Fe 也一起被带走。满槽边进边溢，浓度按 1 − e^(−t/τ) 爬升、冲洗时拖尾，刻蚀量要算整条浓度曲线的积分。HF 处理和冲洗之间晶圆不出液面，这是单槽的好处。',
  dry: 'HF 之后是疏水面：一离开液面，水膜很快缩成水珠，水珠干了就是水痕。所以这段搬送也要快。IPA 把图形缝里的水换掉，表面张力只有水的约 1/3，图形受到的毛细力跟着变小；贴着晶圆的弯月面里 IPA 浓度高、表面张力小，表面张力差把水拉回下面（Marangoni 效应）。提得太快水膜来不及被拉走。减压让残留液体在低温下很快蒸发，氧也少，不容易长水痕。IPA 可燃，所以先用 N₂ 把氧赶走才供 IPA。',
};
const TYPE_WHY = {
  chembath: '药液槽的药液一直循环、保温、过滤，反复用；晶圆提出来时带着一层药液，要马上进下一个槽。',
  onebath: '单槽在同一个槽里换液：快排前期稀释得快，上流后期更稳；注药时满槽边进边溢。',
  dryer: 'IPA 把缝里的水换掉，慢速提拉让 Marangoni 效应把水膜拉走，减压让残留液体很快蒸发。',
};

// 一个单元一个工艺步骤：晶圆不在这个槽里就先搬过来 → 把单元配方发给槽的子控去做（夹爪脏了同时去洗）→ 药液槽：提起来马上送进下一个槽
function unitLineStep(R, i) {
  const ids = R.flow.units, u = { id: ids[i], ...R.units[ids[i]] }, b = BATHS[u.bath];
  const prev = i > 0 ? R.units[ids[i - 1]] : null, next = i + 1 < ids.length ? R.units[ids[i + 1]] : null;
  const toNext = b.type === 'chembath' && next;
  const chuck = (prev && BATHS[prev.bath].type === 'chembath') || b.type === 'dryer';   // 搬过药液 / 要取干片
  let now;
  if (b.type === 'chembath') now = `机械手把整批送进${b.name}，交给升降器浸进 ${describeCond(u)}：${describeSteps(u.steps)}${toNext ? `；提起来马上送进${BATHS[next.bath].name}` : ''}。`;
  else if (b.type === 'onebath') now = `${describeSteps(u.steps)}。${chuck ? '同时机械手去夹爪清洗干燥位，把沾了药液的夹爪洗干净、吹干。' : ''}`;
  else now = `${prev ? `机械手从${BATHS[prev.bath].name}取出晶圆，尽快送进减压干燥槽。` : ''}关盖，${describeSteps(u.steps)}，回到大气压、开盖。同时机械手去洗夹爪、用 N₂ 吹干，准备取干片。`;
  return {
    id: u.id, unit: u.id, focus: u.bath,
    name: `${b.name}：${u.name}${toNext ? `，然后马上送进${BATHS[next.bath].name}` : ''}${chuck && b.type !== 'chembath' ? '（机械手去洗夹爪）' : ''}`,
    now, why: UNIT_WHY[u.id] || TYPE_WHY[b.type],
    *run(M) {
      if (M.wafer !== u.bath) yield* M.bringTo(u.bath);
      const robot = M.st('transfer');
      const clean = robot.chem || (b.type === 'dryer' && robot.wet);
      const g = M.cmd(u.bath, 'RUN_UNIT', { unit: u });
      if (clean) yield* par(g, M.cmd('transfer', 'CHUCK_CLEAN')); else yield* g;
      if (toNext) {
        yield* M.fromTank(u.bath, next.bath);
        M.say(`马上送到${BATHS[next.bath].name}`);
        yield* M.transferTo(next.bath);
        yield* M.toTank(next.bath);
      }
    },
  };
}

// 按配方的流程排出整批的工艺步骤（主控的计划）
export function lineSteps(R) {
  return [...FIXED_HEAD, ...R.flow.units.map((_, i) => unitLineStep(R, i)), ...FIXED_TAIL];
}

