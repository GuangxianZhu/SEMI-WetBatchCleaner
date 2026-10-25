// 整机：装载区 → 药液槽 1（SPM）→ 单槽 1 → 药液槽 2（SC1）→ 单槽 2（DHF）→ 减压干燥槽 → 装载区。
// 槽间搬送机械手一台走全线；每个槽有自己的升降器，只在槽内上下；搬完药液、以及取干片之前，机械手先去夹爪清洗干燥位。
//
// 写法：每一步是一个生成器。每 yield 一次消耗一个时间步，line.step(dt) 用 next(dt) 把 dt 传进去；
// par(...) 让几件事同时进行（例如单槽冲洗的同时，机械手去洗夹爪）。纯计算，不碰界面，node 里能直接跑。

import { P, TANKS, STATION_NAME } from './params.js';
import { OneBath } from './onebath.js';
import { ChemBath } from './chembath.js';
import { Dryer } from './dryer.js';
import { Surface } from './surface.js';
import { DEFAULT } from './recipe.js';
import { SPECIES } from './chem.js';
import { buildGraph, chemBathTemplate, oneBathTemplate, computeFlows, chemBathState, oneBathState, checkInterlocks, FLUID_NAME } from './piping.js';

// 管路（药液槽、单槽的模板，见 docs/管路.md；减压干燥槽、夹爪清洗干燥位以后再做）
export const PIPING = buildGraph([chemBathTemplate('cb1', 'SPM'), oneBathTemplate('ob1'), chemBathTemplate('cb2', 'SC1'), oneBathTemplate('ob2')]);

const NAME = STATION_NAME;
const isCb = id => id === 'cb1' || id === 'cb2';
const isOb = id => id === 'ob1' || id === 'ob2';

// ---------- 生成器小工具 ----------
function* waitS(s) { let t = 0; while (t < s) t += yield; }
function* until(fn, maxS = Infinity) { let t = 0; while (!fn()) { if (t >= maxS) return false; t += yield; } return true; }
function* anim(obj, key, target, dur) {
  const v0 = obj[key];
  let t = 0;
  while (t < dur) { t += yield; obj[key] = v0 + (target - v0) * Math.min(1, t / dur); }
  obj[key] = target;
}
function* par(...gens) {
  const live = gens.map(g => ({ g, done: false }));
  let dt = 0;
  for (;;) {
    for (const s of live) if (!s.done && s.g.next(dt).done) s.done = true;
    if (live.every(s => s.done)) return;
    dt = yield;
  }
}

// ---------- 搬送 ----------
function* robotTo(L, x, task) {
  if (Math.abs(L.robot.x - x) < 1e-9) return;
  L.robot.moving = true;
  if (task) L.robot.task = task;
  for (;;) {
    const dt = yield;
    const d = x - L.robot.x, s = P.robotSpeed * dt;
    if (Math.abs(d) <= s) { L.robot.x = x; break; }
    L.robot.x += Math.sign(d) * s;
  }
  L.robot.moving = false;
}

// z：1 = 交接位置（上），0 = 浸没位置（下）
function* lifterTo(L, id, z, speed = P.liftSpeed, onStep = null) {
  for (;;) {
    const d = z - L.lift[id];
    if (Math.abs(d) < 1e-9) return;
    const dt = yield;
    const s = speed * dt / P.liftTravel;
    L.lift[id] = Math.abs(d) <= s ? z : L.lift[id] + Math.sign(d) * s;
    if (onStep) onStep(dt);
  }
}

// 机械手 ↔ 升降器（或装载区的姿态变换单元）交接，并检查交接联锁
function* handoff(L, from, to) {
  const st = from === 'robot' ? to : from;
  const x = st === 'posture' ? P.X.loader : P.X[st];
  const nm = st === 'posture' ? '姿态变换单元' : NAME[st];
  if (Math.abs(L.robot.x - x) > 1e-3) L.violate(`交接时机械手不在${nm}正上方`);
  if (TANKS.includes(st) && L.lift[st] < 0.999) L.violate(`交接时${nm}的升降器不在交接位置`);
  if (st === 'dr' && L.dr.lid > 0.01) L.violate('减压干燥槽的盖子没开就交接');
  if (L.batch.holder !== from) L.violate('交接时晶圆不在交出的一方');
  const give = from === 'robot';
  if (!give) {
    if (L.robot.chem) L.violate(`夹爪上还沾着 ${L.robot.chem}，没洗就去接片`);
    if (st === 'dr' && L.robot.wet) L.violate('夹爪是湿的，不能去取干片');
  }
  L.robot.task = give ? `把晶圆交给${nm}` : `从${nm}接过晶圆`;
  yield* anim(L.robot, 'chuck', give ? 1 : 0, P.handoffS);
  L.batch.holder = to;
  L.robot.holding = !give;
  if (!give && isCb(st)) { L.robot.chem = L[st].kind; L.robot.wet = true; }
  if (!give && isOb(st)) L.robot.wet = true;
  L.robot.task = '';
}

// 把晶圆放进槽里：升降器升到交接位置 → 交接 → 升降器下降
function* toTank(L, id) {
  L.phase = `${NAME[id]}的升降器升到交接位置`;
  yield* lifterTo(L, id, 1);
  yield* handoff(L, 'robot', id);
  L.applyCarry(id);
  L.phase = `升降器下降，晶圆浸进${NAME[id]}`;
  yield* lifterTo(L, id, 0);
}

// 从槽里取出：升降器提起 → 交接给机械手 → 空升降器降回去。
// 提起的同时，下一个槽的升降器先升到接近交接位置（0.85），机械手到了只差最后一小段，晶圆在空气里的时间短
function* fromTank(L, id, nextId = null) {
  L.phase = `升降器把晶圆提出${NAME[id]}`;
  if (nextId) yield* par(lifterTo(L, id, 1), lifterTo(L, nextId, 0.85));
  else yield* lifterTo(L, id, 1);
  L.carry = L.liquidOf(id);
  yield* handoff(L, id, 'robot');
  L.spawn(lifterTo(L, id, 0));
}

// 带着晶圆移动到下一个槽；airExtraS 模拟机械手半路被别的任务耽误
function* transferTo(L, id) {
  const x = P.X[id];
  if (L.R.airExtraS > 0) {
    yield* robotTo(L, (L.robot.x + x) / 2, `移动到${NAME[id]}`);
    L.robot.task = `被别的任务耽误 ${L.R.airExtraS} s`;
    L.phase = `机械手被别的任务耽误了 ${L.R.airExtraS} s，晶圆一直在空气里`;
    yield* waitS(L.R.airExtraS);
  }
  yield* robotTo(L, x, `移动到${NAME[id]}`);
}

// 夹爪清洗干燥：冲洗 → N₂ 吹干（和槽里的处理同时进行）
function* chuckClean(L) {
  yield* robotTo(L, P.X.chuck, '去夹爪清洗干燥位');
  L.chuckSt = 'wash'; L.robot.task = '冲洗夹爪';
  yield* waitS(P.chuckWashS);
  L.robot.chem = null;
  L.chuckSt = 'dry'; L.robot.task = 'N₂ 吹干夹爪';
  yield* waitS(P.chuckDryS);
  L.robot.wet = false;
  L.chuckSt = null; L.robot.task = '待机';
}

// ---------- 单槽 ----------
function* qdrCycle(L, id, Tin, label) {
  const ob = L[id], shower = !!L.R.shower;
  L.phase = `${label}：快排，几秒内排空${shower ? '，淋浴让晶圆保持湿润' : '（没开淋浴，晶圆露在空气里）'}`;
  ob.startDump(shower);
  yield* until(() => ob.empty);
  ob.stopDump();
  L.phase = `${label}：补水 ${Tin} °C${shower ? '，淋浴一直喷到晶圆浸没' : ''}`;
  ob.supply(P.refillLpm, Tin, null, shower);
  yield* until(() => ob.full);
  ob.stop();
}

function* rinseUpflow(L, id) {
  const ob = L[id], R = L.R;
  ob.supply(R.upflowLpm, P.coldC);
  let t = 0;
  if (R.rinseMode === 'time') {
    L.phase = `${NAME[id]}：上流冲洗 ${R.rinseTimeS} s（只按时间）`;
    while (t < R.rinseTimeS) t += yield;
  } else {
    L.phase = `${NAME[id]}：上流冲洗，等比电阻 ≥ ${R.rinseRho} MΩ·cm 且至少 ${R.rinseMinS} s`;
    while (!(t >= R.rinseMinS && ob.rho >= R.rinseRho)) {
      t += yield;
      if (t > 3600) { L.notes.push(`${NAME[id]}上流冲洗 1 小时还没到比电阻判定值`); break; }
    }
  }
  ob.stop();
  L.rinseLog.push({ id, t, rho: ob.rho });
}

function* rinseOb1(L) {
  const R = L.R;
  for (let i = 0; i < R.ob1HotQdr; i++) yield* qdrCycle(L, 'ob1', R.hotT, `热水快排冲洗 ${i + 1}/${R.ob1HotQdr}`);
  for (let i = 0; i < R.ob1ColdQdr; i++) yield* qdrCycle(L, 'ob1', P.coldC, `冷水快排冲洗 ${i + 1}/${R.ob1ColdQdr}`);
  yield* rinseUpflow(L, 'ob1');
}

function* rinseOb2(L) {
  const R = L.R;
  for (let i = 0; i < R.ob2Qdr; i++) yield* qdrCycle(L, 'ob2', P.coldC, `冷水快排冲洗 ${i + 1}/${R.ob2Qdr}`);
  yield* rinseUpflow(L, 'ob2');
}

function* dhf(L) {
  const ob = L.ob2, R = L.R;
  if (R.dhfS > 0) {
    if (ob.c.NH3 > 1e-5) L.notes.push('单槽 2 里还有氨水就进了 HF（会生成 NH₄F），SC1 之后要先冲干净');
    L.phase = `注入 DHF（1 : ${R.dhfRatio}）${R.dhfS} s：满槽边进边溢，浓度慢慢爬升`;
    ob.supply(R.upflowLpm, P.coldC, { species: 'HF', ratio: R.dhfRatio });
    yield* waitS(R.dhfS);
  }
  yield* rinseUpflow(L, 'ob2');
}

// ---------- 减压干燥槽 ----------
function* dryerSeq(L) {
  const d = L.dr, R = L.R;
  L.phase = '关上密封盖';
  yield* anim(d, 'lid', 1, 3);
  L.phase = 'N₂ 置换：把槽里的氧赶走';
  d.n2On = true;
  yield* until(() => d.o2 < 1, 180);
  if (R.ipa) {
    if (d.lid < 0.99 || d.o2 > 2) L.violate('盖子没关好或氧浓度没降下来就供 IPA');
    L.phase = '水面上供 IPA，形成一层 IPA';
    d.ipaOn = true;
    yield* waitS(60);
  }
  L.phase = `慢速提拉 ${R.liftMmS} mm/s：晶圆从水里穿过${R.ipa ? ' IPA 层' : '水面'}到气体层`;
  L.drying = true;
  d.lift = null;
  yield* lifterTo(L, 'dr', 1, R.liftMmS / 1000, () => d.liftSample(R.liftMmS));
  d.ipaOn = false;
  L.surf.applyDrying(d.liftResult(), !!R.vacuum);
  L.dried = true;
  if (R.vacuum) { L.phase = '减压：残留的液体在低温下很快蒸发'; d.vacOn = true; yield* waitS(40); }
  L.phase = 'N₂ 吹干';
  yield* waitS(R.vacuum ? 60 : 180);
  d.vacOn = false;
  L.phase = '回到大气压';
  yield* until(() => d.pressure > 100, 60);
  d.n2On = false;
  L.phase = '打开密封盖';
  yield* anim(d, 'lid', 0, 3);
  L.drying = false;
}

// ---------- 药液槽换液（维护动作，没在跑批时才能做；给管路图演示阀门和联锁） ----------
function* bathExchange(L, id) {
  const cb = L[id], nm = NAME[id];
  const chemName = { DIW: 'DIW', C1: FLUID_NAME[cb.chem[0]], C2: FLUID_NAME[cb.chem[1]] };
  L.phase = `${nm}：先停加热器和循环泵（排液时泵会空转、加热器会空烧）`;
  cb.heater = false; cb.pump = false;
  yield* waitS(3);
  L.phase = `${nm}：打开内槽、外槽排液阀，排掉旧液`;
  cb.valve.V_DR = true; cb.valve.V_DRO = true;
  yield* until(() => cb.empty, 900);
  cb.valve.V_DR = false; cb.valve.V_DRO = false;
  cb.planFill();
  for (const k of ['DIW', 'C1', 'C2']) {
    if (cb.fillTarget[k] < 0.01) continue;
    L.phase = `${nm}：补 ${chemName[k]} ${cb.fillTarget[k].toFixed(1)} L（从上方进内槽，满了溢流到外槽）`;
    cb.valve[`V_${k}`] = true;
    yield* until(() => cb.filled[k] >= cb.fillTarget[k], 1800);
    cb.valve[`V_${k}`] = false;
  }
  L.phase = `${nm}：外槽液位够了，开循环泵`;
  cb.pump = true;
  yield* waitS(5);
  L.phase = `${nm}：开加热器，升温到 ${cb.Tset} °C`;
  cb.heater = true;
  yield* until(() => cb.T >= cb.Tset - 0.05, 4 * 3600);
  L.phase = `${nm}：换液完成`;
}

// ---------- 工艺步骤 ----------
export const STEPS = [
  {
    id: 'load', name: '晶圆盒到位、开门、映射', focus: 'loader',
    now: '两个 FOUP 放到装载口，FOUP 门和设备的门对接后一起打开，再逐个槽位扫描。',
    why: '先确认哪些槽位有片、有没有叠片或斜片，否则批量机械手一次取 25 片时会撞片。',
    *run(L) {
      L.phase = '两个 FOUP 放到装载口'; yield* waitS(2);
      L.phase = 'FOUP 门和设备的门一起打开'; yield* anim(L.loader, 'door', 1, 2);
      L.phase = '晶圆映射：逐个槽位扫描'; yield* anim(L.loader, 'map', 1, 4);
    },
  },
  {
    id: 'pick', name: '批量取片、合批', focus: 'loader',
    now: '批量机械手一次从 FOUP 1 取出 25 片，再从 FOUP 2 取 25 片，交错插进去：两盒合成 50 片，间距从 10 mm 变成 5 mm。',
    why: '一片一片取太慢；合批（半间距）让一个槽一次洗 50 片，产能翻倍。代价是片间缝隙只剩约 4.2 mm，液流穿过片间更难。',
    *run(L) {
      L.batch.holder = 'pick';
      L.phase = '批量机械手从 FOUP 1 一次取出 25 片'; yield* anim(L.loader, 'pick1', 1, 6);
      L.phase = '再从 FOUP 2 取出 25 片，交错插进去'; yield* anim(L.loader, 'pick2', 1, 6);
      L.batch.holder = 'posture';
    },
  },
  {
    id: 'posture', name: '姿态变换：水平 → 竖直', focus: 'loader',
    now: '整批晶圆从水平转成竖直。',
    why: '槽里的晶圆是竖着放的：液流从底部往上穿过片间，从溢流口流走；提出液面时水也能顺着往下流。',
    *run(L) { L.phase = '整批从水平转成竖直'; yield* anim(L.loader, 'posture', 1, 6); },
  },
  {
    id: 'spm', name: '药液槽 1：SPM，然后马上送进单槽 1', focus: 'cb1',
    now: r => `机械手把整批送到药液槽 1，交给升降器浸进 SPM（${r.spmRatio} : 1，${r.spmT} °C），泡 ${r.spmMin} 分钟；提起来马上送进单槽 1。`,
    why: 'SPM 把有机物和光刻胶残留氧化分解掉。药液从内槽溢流到外槽，泵经过滤器和加热器打回内槽底部：表面一直在更新，颗粒被过滤器拦下。晶圆提出来时带着一层高温、高浓度的药液，在空气里待久了会局部变干，所以要马上进单槽。',
    *run(L) {
      const R = L.R;
      L.phase = '槽间搬送机械手到装载区接批';
      yield* par(robotTo(L, P.X.loader, '移动到装载区'), lifterTo(L, 'cb1', 0.85));
      yield* handoff(L, 'posture', 'robot');
      L.phase = '送到药液槽 1';
      yield* robotTo(L, P.X.cb1, '移动到药液槽 1');
      yield* toTank(L, 'cb1');
      L.phase = `SPM 浸泡 ${R.spmMin} min（${R.spmT} °C）`;
      yield* waitS(R.spmMin * 60);
      yield* fromTank(L, 'cb1', 'ob1');
      L.phase = '马上送到单槽 1';
      yield* transferTo(L, 'ob1');
      yield* toTank(L, 'ob1');
    },
  },
  {
    id: 'rinse1', name: '单槽 1：快排冲洗 → 上流冲洗（机械手去洗夹爪）', focus: 'ob1',
    now: r => `先用 ${r.hotT} °C 热水快排冲洗 ${r.ob1HotQdr} 次、冷水 ${r.ob1ColdQdr} 次，再上流冲洗到终点。同时机械手去夹爪清洗干燥位，把沾了 SPM 的夹爪洗干净、吹干。`,
    why: '快排前期稀释得快：每排一次只剩约 2 % 的残液；后期上流更稳，从底部进水、溢流带走。硫酸黏、难冲，所以先用热水。比电阻前面一直很低，到最后才猛地升上去：比电阻和离子浓度成反比，浓度按指数下降。',
    *run(L) { yield* par(rinseOb1(L), chuckClean(L)); },
  },
  {
    id: 'sc1', name: '药液槽 2：SC1 + 兆声，然后马上送进单槽 2', focus: 'cb2',
    now: r => `机械手从单槽 1 取出晶圆，送进药液槽 2 的 SC1（NH₄OH : H₂O₂ : H₂O = ${r.sc1Nh3} : 1 : ${r.sc1Water}，${r.sc1T} °C）泡 ${r.sc1Min} 分钟${r.mega ? '，开兆声' : ''}；提起来马上送进单槽 2。`,
    why: 'H₂O₂ 氧化表面、NH₄OH 慢慢溶掉氧化层，把颗粒从底下掏松；碱性下颗粒和硅表面都带负电，互相排斥，不容易再粘回去。兆声（约 1 MHz）帮忙把小颗粒冲走。代价：硅也被刻掉一点，表面变粗糙；SC1 还会让 Fe 沉积到表面。',
    *run(L) {
      const R = L.R;
      L.phase = '机械手到单槽 1';
      yield* robotTo(L, P.X.ob1, '移动到单槽 1');
      yield* fromTank(L, 'ob1', 'cb2');
      L.phase = '送到药液槽 2';
      yield* transferTo(L, 'cb2');
      yield* toTank(L, 'cb2');
      if (R.mega) { L.cb2.mega = true; L.cb2.megaP = R.megaP / 100; }
      L.phase = `SC1 浸泡 ${R.sc1Min} min（${R.sc1T} °C）${R.mega ? '，兆声开' : ''}`;
      yield* waitS(R.sc1Min * 60);
      L.cb2.mega = false;
      yield* fromTank(L, 'cb2', 'ob2');
      L.phase = '马上送到单槽 2';
      yield* transferTo(L, 'ob2');
      yield* toTank(L, 'ob2');
    },
  },
  {
    id: 'rinse2', name: '单槽 2：快排冲洗 → 上流冲洗（机械手去洗夹爪）', focus: 'ob2',
    now: r => `冷水快排冲洗 ${r.ob2Qdr} 次，再上流冲洗到终点。同时机械手去洗掉夹爪上的 SC1。`,
    why: '后面要在同一个槽里进 HF：槽里还有氨水的话，会生成 NH₄F，所以先把 SC1 冲干净。',
    *run(L) { yield* par(rinseOb2(L), chuckClean(L)); },
  },
  {
    id: 'dhf', name: '单槽 2：DHF → 上流冲洗', focus: 'ob2',
    now: r => `往 DIW 流里按 1 : ${r.dhfRatio} 注入 HF，注入 ${r.dhfS} s；停止注入，继续上流冲洗到终点。`,
    why: '去掉 SC1 留下的化学氧化膜，表面变成 H 终端、疏水；嵌在氧化膜里的 Fe 也一起被带走。满槽边进边溢，浓度按 1 − e^(−t/τ) 爬升、冲洗时拖尾，刻蚀量要算整条浓度曲线的积分。HF 处理和冲洗之间晶圆不出液面，这是单槽的好处。',
    *run(L) { yield* dhf(L); },
  },
  {
    id: 'todr', name: '尽快送进减压干燥槽', focus: 'dr',
    now: '机械手从单槽 2 取出晶圆，尽快送进减压干燥槽，浸进槽里的水。',
    why: 'HF 之后是疏水面：一离开液面，水膜很快缩成水珠，水珠干了就是水痕。所以这段搬送也要快。',
    *run(L) {
      L.phase = '机械手到单槽 2';
      yield* robotTo(L, P.X.ob2, '移动到单槽 2');
      yield* fromTank(L, 'ob2', 'dr');
      L.phase = '尽快送到减压干燥槽';
      yield* transferTo(L, 'dr');
      yield* toTank(L, 'dr');
    },
  },
  {
    id: 'dry', name: '减压干燥：IPA → 慢速提拉 → 减压 → N₂ 吹干（机械手去洗夹爪、吹干）', focus: 'dr',
    now: r => `关盖、N₂ 置换${r.ipa ? '、水面上供 IPA' : ''}，升降器以 ${r.liftMmS} mm/s 把晶圆慢慢提起${r.vacuum ? '，再减压' : ''}、N₂ 吹干。同时机械手去洗夹爪、用 N₂ 吹干，准备取干片。`,
    why: 'IPA 把图形缝里的水换掉，表面张力只有水的约 1/3，图形受到的毛细力跟着变小；贴着晶圆的弯月面里 IPA 浓度高、表面张力小，表面张力差把水拉回下面（Marangoni 效应）。提得太快水膜来不及被拉走。减压让残留液体在低温下很快蒸发，氧也少，不容易长水痕。IPA 可燃，所以先用 N₂ 把氧赶走才供 IPA。',
    *run(L) { yield* par(dryerSeq(L), chuckClean(L)); },
  },
  {
    id: 'unload', name: '取出、转回水平、分回两个 FOUP', focus: 'loader',
    now: '机械手用干的夹爪从减压干燥槽取出干片，送回装载区；转回水平，分回两个 FOUP，关门。',
    why: '夹爪要先干燥：搬过单槽 2 的湿片以后夹爪是湿的，直接去取干片会把片边弄湿。每片晶圆都要回到原来 FOUP 的原来槽位（晶圆追踪）。',
    *run(L) {
      L.phase = '机械手到减压干燥槽';
      yield* robotTo(L, P.X.dr, '移动到减压干燥槽');
      yield* handoff(L, 'dr', 'robot');
      L.spawn(lifterTo(L, 'dr', 0));
      L.phase = '送回装载区';
      yield* robotTo(L, P.X.loader, '移动到装载区');
      yield* handoff(L, 'robot', 'posture');
      L.phase = '整批从竖直转回水平'; yield* anim(L.loader, 'posture', 0, 6);
      L.batch.holder = 'pick';
      L.phase = '分回 FOUP 2'; yield* anim(L.loader, 'pick2', 0, 6);
      L.phase = '分回 FOUP 1'; yield* anim(L.loader, 'pick1', 0, 6);
      L.batch.holder = 'foup';
      L.checkTracking();
      L.phase = '关门'; yield* anim(L.loader, 'door', 0, 2);
    },
  },
];

// ---------- 整机 ----------
export class Line {
  constructor(recipe = {}) {
    this.R = { ...DEFAULT, ...recipe };
    this.t = 0;
    this.robot = { x: P.X.loader, chuck: 1, holding: false, wet: false, chem: null, moving: false, task: '待机' };
    this.lift = { cb1: 0, ob1: 0, cb2: 0, ob2: 0, dr: 0 };   // 空着时停在下面，要交接时才升上来
    this.bg = [];                      // 后台动作（例如空升降器降回去）
    this.batch = { holder: 'foup' };   // foup / pick / posture / robot / cb1 / ob1 / cb2 / ob2 / dr
    this.loader = { door: 0, map: 0, pick1: 0, pick2: 0, posture: 0 };
    this.cb1 = new ChemBath('SPM'); this.cb1.configure(this.R);
    this.cb2 = new ChemBath('SC1'); this.cb2.configure(this.R);
    this.ob1 = new OneBath();
    this.ob2 = new OneBath();
    this.dr = new Dryer();
    this.surf = new Surface();
    this.chuckSt = null;               // 'wash' / 'dry' / null
    this.carry = null;                 // 晶圆身上带着的液体
    this.air = { t: 0, active: false, from: null, log: [] };
    this.lastTank = null;
    this.wasExposed = { ob1: false, ob2: false };
    this.wetted = false; this.dried = false; this.drying = false;
    this.violations = []; this.notes = []; this.rinseLog = [];
    this.stepIdx = -1; this.runner = null; this.stepT0 = 0; this.stepTimes = [];
    this.phase = '';
    this.task = null; this.lastTask = null; this.batchT0 = 0;
    this.done = false;
    // 晶圆追踪：批里第 b 片来自哪个 FOUP 的哪个槽位（两盒交错合批）
    this.origin = Array.from({ length: P.nWafer }, (_, b) => ({ foup: 1 + (b % 2), slot: Math.floor(b / 2) }));
    this.trackingOk = null;
  }

  get busy() { return !!this.runner; }

  // 后台动作：和步骤并行，自己跑完
  spawn(gen) { gen.next(0); this.bg.push(gen); }

  violate(msg) { this.violations.push({ t: this.t, msg }); }

  // 维护动作（例如换液）：不算工艺步骤，没在跑批时才能做
  get canMaintain() { return !this.busy && (this.stepIdx < 0 || this.done); }
  startExchange(id) {
    if (!this.canMaintain) return false;
    this.task = `${NAME[id]} 换液`;
    this.runner = bathExchange(this, id);
    this.runner.next(0);
    return true;
  }

  // 管路：阀门、泵、槽的状态 → 哪些管段在流
  piping() {
    const state = { open: {}, run: {}, tank: {}, heater: {} };
    chemBathState('cb1', this.cb1, state);
    chemBathState('cb2', this.cb2, state);
    oneBathState('ob1', this.ob1, state);
    oneBathState('ob2', this.ob2, state);
    const { flows, blocked } = computeFlows(PIPING, state);
    return { state, flows, blocked, bad: checkInterlocks(PIPING, state, flows, blocked) };
  }

  startStep(i) {
    this.task = null;
    if (i === 0) this.batchT0 = this.t;   // 这一批从这里开始计时（前面可能做过换液）
    this.stepIdx = i;
    this.stepT0 = this.t;
    this.runner = STEPS[i].run(this);
    this.runner.next(0);
  }

  step(dt) {
    this.t += dt;
    this.cb1.step(dt); this.cb2.step(dt);
    this.ob1.step(dt); this.ob2.step(dt); this.dr.step(dt);
    this.bg = this.bg.filter(g => !g.next(dt).done);
    if (this.runner && this.runner.next(dt).done) {
      this.runner = null;
      if (this.task) { this.lastTask = this.task; this.task = null; }
      else {
        this.stepTimes[this.stepIdx] = this.t - this.stepT0;
        if (this.stepIdx === STEPS.length - 1) this.done = true;
      }
    }
    this.updateWafers(dt);
  }

  // 一口气跑完全部步骤（测试和配方页的预览用）
  runAll(dt = 0.1) {
    for (let i = 0; i < STEPS.length; i++) {
      this.startStep(i);
      while (this.busy) this.step(dt);
    }
    while (this.bg.length) this.step(dt);
    return this;
  }

  liquidOf(id) {
    if (isCb(id)) return { c: this[id].c, T: this[id].T, from: id };
    if (isOb(id)) return { c: { ...this[id].c }, T: this[id].T, from: id };
    return null;
  }

  // 晶圆带着上一个槽的液体进下一个槽
  applyCarry(id) {
    const k = this.carry;
    this.carry = null;
    if (!k) return;
    if (isOb(id)) this[id].addLiquid(P.dragOutL, k.c, k.T);
    if (isCb(id)) {
      this[id].dragIn(P.dragOutL, k.c);
      let mol = 0;
      for (const s of SPECIES) if (s !== 'H2O2') mol += (k.c[s] || 0) * P.dragOutL;
      this.surf.carryInto(mol * 1000);
    }
  }

  // 晶圆在哪、泡在什么里、是不是露在空气里
  wafersIn() {
    const h = this.batch.holder;
    if (!TANKS.includes(h)) return { tank: null, inLiq: false, exposed: false };
    const down = this.lift[h] <= 0.5;      // 升降器在下半程：晶圆一半以上还在液面下
    if (isOb(h)) {
      const covered = this[h].level >= 0.5;
      return { tank: h, inLiq: down && covered, exposed: down && !covered };
    }
    return { tank: h, inLiq: down, exposed: false };
  }

  updateWafers(dt) {
    const { tank, inLiq, exposed } = this.wafersIn();
    if (inLiq) {
      if (tank === 'cb1') this.surf.inSPM(dt, this.cb1.T);
      else if (tank === 'cb2') this.surf.inSC1(dt, this.cb2);
      else if (isOb(tank)) this.surf.inOneBath(dt, this[tank].c);
    }
    // 快排时晶圆露出液面：每次快排记一次
    for (const id of ['ob1', 'ob2']) {
      const ex = exposed && tank === id;
      if (ex && !this.wasExposed[id]) this.surf.qdrExposed(this[id].shower);
      this.wasExposed[id] = ex;
    }
    // 搬送时在空气里的时间（第一次浸湿以后、干燥之前）
    if (inLiq) {
      if (this.air.active) {
        this.air.log.push({ from: this.air.from, to: tank, t: this.air.t });
        this.surf.airExposure(this.air.t, isCb(this.air.from) ? 'cb' : 'ob');
        this.air.active = false;
      }
      this.wetted = true;
      this.lastTank = tank;
    } else if (this.wetted && !this.dried && !exposed && !this.drying) {
      if (!this.air.active) { this.air.active = true; this.air.t = 0; this.air.from = this.lastTank; }
      this.air.t += dt;
    }
  }

  checkTracking() {
    // 分回 FOUP：批里第 b 片回到 origin[b]；检查每个 FOUP 的每个槽位正好回来一片
    const seen = new Set();
    for (const o of this.origin) seen.add(`${o.foup}-${o.slot}`);
    this.trackingOk = seen.size === P.nWafer;
    if (!this.trackingOk) this.violate('晶圆没有回到原来的槽位');
  }

  usage() {
    return {
      diwL: this.ob1.diwL + this.ob2.diwL,
      hfL: this.ob2.chemL.HF || 0,
      ipaL: this.dr.ipaL,
      dragL: 2 * P.dragOutL,
    };
  }
}

// 按配方从头到尾跑一遍（配方页预览用；步长大一点，几十毫秒跑完）
export function simulate(recipe, dt = 0.25) { return new Line(recipe).runAll(dt); }
