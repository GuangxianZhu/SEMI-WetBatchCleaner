// 子控（docs/软件结构.md）：真机里跑在 Linux PC 上，负责"执行"。
//   装载（loader）：FOUP、晶圆映射、批量取片合批、姿态变换
//   搬送（transfer）：槽间搬送机械手、夹爪清洗干燥
//   各个槽（cb1、ob1、cb2、ob2、dr）：自己的升降器、按主控发来的单元配方一步一步做、换液
// 子控只听主控的命令（cmd），做完回 done；出问题回 alarm；过程记录（单元里一步的开始 / 结束等）回 event。
// 子控直接操作自己的设备（这里是 Line 上的设备对象），不碰别的子控的设备。

import { P, STATION_NAME, TANKS } from './params.js';
import { BATHS } from './recipe.js';
import { FLUID_NAME } from './piping.js';
import { waitS, until, anim } from './gen.js';

const NAME = STATION_NAME;

// ---------- 子控的共同部分：收命令 → 开一个作业（生成器）→ 每个时间步推进 → 做完回 done ----------
class Sub {
  constructor(addr, L, bus) {
    this.addr = addr; this.L = L; this.bus = bus;
    this.jobs = [];
    bus.on(addr, m => this.receive(m));
  }
  receive(m) {
    if (m.type !== 'cmd') return;
    const b = m.body, chan = this.channel(b.cmd);
    // 同一个通道（例如升降器）来了新命令：旧的作业作废
    if (chan) this.jobs = this.jobs.filter(j => j.chan !== chan);
    const job = { id: m.id, cmd: b.cmd, chan, g: this.exec(b.cmd, b) };
    this.jobs.push(job);
    this.tick(job, 0);       // 先走到第一个 yield（不花时间）
    this.report();
  }
  tick(job, dt) {
    if (!job.g.next(dt).done) return;
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.bus.send(this.addr, 'main', 'done', { of: job.id, cmd: job.cmd });
  }
  advance(dt) {
    for (const job of [...this.jobs]) if (this.jobs.includes(job)) this.tick(job, dt);
    this.report();
  }
  channel() { return null; }
  alarm(msg) { this.bus.send(this.addr, 'main', 'alarm', { msg }); }
  event(kind, data = {}) { this.bus.send(this.addr, 'main', 'event', { kind, ...data }); }
  say(text) { this.L.phase = text; }      // 现在在做什么（画面上的说明）
}

// ---------- 装载 ----------
export class LoaderSub extends Sub {
  constructor(L, bus) { super('loader', L, bus); }
  *exec(cmd, b) {
    const L = this.L, ld = L.loader;
    if (cmd === 'DOCK') yield* waitS(2);                               // FOUP 放到装载口、夹紧
    else if (cmd === 'DOOR') yield* anim(ld, 'door', b.open ? 1 : 0, 2);
    else if (cmd === 'MAP') yield* anim(ld, 'map', 1, 4);
    else if (cmd === 'TAKE') {                                         // 批量取片：从 FOUP n 取 25 片
      if (b.n === 1) L.moveWafers('foup', 'pick');
      yield* anim(ld, b.n === 1 ? 'pick1' : 'pick2', 1, 6);
      if (b.n === 2) L.moveWafers('pick', 'posture');
    } else if (cmd === 'POSTURE') {                                    // 1 = 竖直（进槽）、0 = 水平
      yield* anim(ld, 'posture', b.to, 6);
      if (b.to === 0) L.moveWafers('posture', 'pick');
    } else if (cmd === 'RETURN') {                                     // 分回 FOUP n
      yield* anim(ld, b.n === 1 ? 'pick1' : 'pick2', 0, 6);
      if (b.n === 1) L.moveWafers('pick', 'foup');
    }
  }
  report() { this.bus.status.loader = { ...this.L.loader, busy: this.jobs.length > 0 }; }
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

// 夹爪清洗干燥：冲洗 → N₂ 吹干
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

export class TransferSub extends Sub {
  constructor(L, bus) { super('transfer', L, bus); }
  *exec(cmd, b) {
    const L = this.L;
    if (cmd === 'MOVE') yield* robotTo(L, b.x, b.task);
    else if (cmd === 'HOLD') { L.robot.task = b.task; yield* waitS(b.s); }     // 被别的任务占住
    else if (cmd === 'PICK' || cmd === 'PLACE') yield* this.handoff(cmd === 'PLACE', b);
    else if (cmd === 'CHUCK_CLEAN') yield* chuckClean(L);
  }
  // 交接：张开 / 合上夹爪。b.st：对方（槽或姿态变换单元）；b.type：对方是哪种槽
  *handoff(give, b) {
    const L = this.L;
    if (!give && TANKS.includes(b.st)) L.carry = L.liquidOf(b.st);   // 晶圆提出来时带着一层液体（机台的物理）
    L.robot.task = give ? `把晶圆交给${b.nm}` : `从${b.nm}接过晶圆`;
    yield* anim(L.robot, 'chuck', give ? 1 : 0, P.handoffS);
    L.moveWafers(give ? 'robot' : b.st, give ? b.st : 'robot');
    L.robot.holding = !give;
    if (!give && b.type === 'chembath') { L.robot.chem = b.chem; L.robot.wet = true; }
    if (!give && b.type === 'onebath') L.robot.wet = true;
    L.robot.task = '';
  }
  report() {
    const r = this.L.robot;
    this.bus.status.transfer = { x: r.x, holding: r.holding, wet: r.wet, chem: r.chem, busy: this.jobs.length > 0 };
  }
}

// ---------- 槽 ----------
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

// 单槽：快排冲洗
function* qdrCycle(S, Tin, label, shower) {
  const ob = S.L[S.addr];
  S.say(`${label}：快排，几秒内排空${shower ? '，淋浴让晶圆保持湿润' : '（没开淋浴，晶圆露在空气里）'}`);
  ob.startDump(shower);
  yield* until(() => ob.empty);
  ob.stopDump();
  S.say(`${label}：补水 ${Tin} °C${shower ? '，淋浴一直喷到晶圆浸没' : ''}`);
  ob.supply(P.refillLpm, Tin, null, shower);
  yield* until(() => ob.full);
  ob.stop();
}

// 单槽：上流冲洗（按比电阻或按时间结束）
function* rinseUpflow(S, s, tag) {
  const id = S.addr, ob = S.L[id];
  ob.supply(s.lpm, s.T);
  let t = 0;
  if (s.end === 'time') {
    S.say(`${tag}${NAME[id]}：上流冲洗 ${s.s} s（只按时间）`);
    while (t < s.s) t += yield;
  } else {
    S.say(`${tag}${NAME[id]}：上流冲洗，等比电阻 ≥ ${s.rho} MΩ·cm 且至少 ${s.minS} s`);
    while (!(t >= s.minS && ob.rho >= s.rho)) {
      t += yield;
      if (t > 3600) { S.event('note', { msg: `${NAME[id]}上流冲洗 1 小时还没到比电阻判定值` }); break; }
    }
  }
  ob.stop();
  S.event('rinse', { id, t, rho: ob.rho });
}

// 单槽：注药（满槽边进边溢；不停供液，下一步通常是上流冲洗，接着换成纯 DIW）
function* injectStep(S, s, tag) {
  const id = S.addr, ob = S.L[id];
  if (s.chem === 'HF' && ob.c.NH3 > 1e-5) S.event('note', { msg: `${NAME[id]} 里还有氨水就进了 HF（会生成 NH₄F），SC1 之后要先冲干净` });
  const nm = s.chem === 'HF' ? 'DHF' : FLUID_NAME[s.chem];
  S.say(`${tag}注入 ${nm}（1 : ${s.ratio}）${s.s} s：满槽边进边溢，浓度慢慢爬升`);
  ob.supply(s.lpm, P.coldC, { species: s.chem, ratio: s.ratio });
  yield* waitS(s.s);
}

const stepTag = (i, n) => (n > 1 ? `[${i + 1}/${n}] ` : '');
// 单元里的一步：开始、结束各报一次给主控（配方页显示实际用了多久）
function* logStep(S, u, i, gen) {
  S.event('stepStart', { unit: u.id, i, step: u.steps[i].kind });
  yield* gen;
  S.event('stepEnd', { unit: u.id, i });
}

function* chemBathUnit(S, u) {
  const cb = S.L[S.addr], hasMega = !!BATHS[S.addr].mega;
  for (let i = 0; i < u.steps.length; i++) {
    const s = u.steps[i], mega = hasMega && s.mega > 0;
    cb.mega = mega; cb.megaP = mega ? s.mega / 100 : 0;
    S.say(`${stepTag(i, u.steps.length)}${cb.kind} 浸泡 ${+(s.s / 60).toFixed(1)} min（${cb.Tset} °C）${mega ? '，兆声开' : ''}`);
    yield* logStep(S, u, i, waitS(s.s));
  }
  cb.mega = false;
}

function* oneBathUnit(S, u) {
  const n = u.steps.length;
  for (let i = 0; i < n; i++) {
    const s = u.steps[i], tag = stepTag(i, n);
    if (s.kind === 'qdr') yield* logStep(S, u, i, qdrCycle(S, s.T, `${tag}${s.T > 30 ? '热水' : '冷水'}快排冲洗`, !!s.shower));
    else if (s.kind === 'upflow') yield* logStep(S, u, i, rinseUpflow(S, s, tag));
    else if (s.kind === 'inject') yield* logStep(S, u, i, injectStep(S, s, tag));
  }
  S.L[S.addr].stop();
}

// 减压干燥槽：慢速提拉；提完按"后面有没有减压"判定干燥的结果（晶圆表面的物理）
function* liftDry(S, mmS, vacuum, tag = '') {
  const L = S.L, d = L.dr;
  S.say(`${tag}慢速提拉 ${mmS} mm/s：晶圆从水里穿过${d.ipaOn ? ' IPA 层' : '水面'}到气体层`);
  L.drying = true;
  d.lift = null;
  yield* lifterTo(L, 'dr', 1, mmS / 1000, () => d.liftSample(mmS));
  d.ipaOn = false;
  L.surf.applyDrying(d.liftResult(), vacuum);
  L.dried = true;
}

// 减压干燥槽：关盖 → 单元里的步骤 → 回到大气压 → 开盖
function* dryerUnit(S, u) {
  const d = S.L.dr, n = u.steps.length, vacuum = u.steps.some(s => s.kind === 'vacuum');
  let lifted = false;
  S.say('关上密封盖');
  yield* anim(d, 'lid', 1, 3);
  for (let i = 0; i < n; i++) {
    const s = u.steps[i], tag = stepTag(i, n);
    let g;
    if (s.kind === 'purge') g = (function* () { S.say(`${tag}N₂ 置换：把槽里的氧赶走`); d.n2On = true; yield* until(() => d.o2 < 1, s.maxS); })();
    else if (s.kind === 'ipa') g = (function* () {
      if (d.lid < 0.99 || d.o2 > 2) S.alarm('盖子没关好或氧浓度没降下来就供 IPA');
      S.say(`${tag}水面上供 IPA，形成一层 IPA`); d.ipaOn = true; yield* waitS(s.s);
    })();
    else if (s.kind === 'lift') { g = liftDry(S, s.mmS, vacuum, tag); lifted = true; }
    else if (s.kind === 'vacuum') g = (function* () { S.say(`${tag}减压：残留的液体在低温下很快蒸发`); d.vacOn = true; yield* waitS(s.s); })();
    else if (s.kind === 'n2dry') g = (function* () { S.say(`${tag}N₂ 吹干`); d.n2On = true; yield* waitS(s.s); })();
    if (g) yield* logStep(S, u, i, g);
  }
  if (!lifted) { S.event('note', { msg: '干燥单元里没有"慢速提拉"，按 1 mm/s 提起来' }); yield* liftDry(S, 1.0, vacuum); }
  d.vacOn = false;
  S.say('回到大气压');
  yield* until(() => d.pressure > 100, 60);
  d.n2On = false;
  S.say('打开密封盖');
  yield* anim(d, 'lid', 0, 3);
  S.L.drying = false;
}

// 药液槽换液（维护动作；给管路图演示阀门和联锁）
function* bathExchange(S) {
  const id = S.addr, cb = S.L[id], nm = NAME[id];
  const chemName = { DIW: 'DIW', C1: FLUID_NAME[cb.chem[0]], C2: FLUID_NAME[cb.chem[1]] };
  S.say(`${nm}：先停加热器和循环泵（排液时泵会空转、加热器会空烧）`);
  cb.heater = false; cb.pump = false;
  yield* waitS(3);
  S.say(`${nm}：打开内槽、外槽排液阀，排掉旧液`);
  cb.valve.V_DR = true; cb.valve.V_DRO = true;
  yield* until(() => cb.empty, 900);
  cb.valve.V_DR = false; cb.valve.V_DRO = false;
  cb.planFill();
  for (const k of ['DIW', 'C1', 'C2']) {
    if (cb.fillTarget[k] < 0.01) continue;
    S.say(`${nm}：补 ${chemName[k]} ${cb.fillTarget[k].toFixed(1)} L（从上方进内槽，满了溢流到外槽）`);
    cb.valve[`V_${k}`] = true;
    yield* until(() => cb.filled[k] >= cb.fillTarget[k], 1800);
    cb.valve[`V_${k}`] = false;
  }
  S.say(`${nm}：外槽液位够了，开循环泵`);
  cb.pump = true;
  yield* waitS(5);
  S.say(`${nm}：开加热器，升温到 ${cb.Tset} °C`);
  cb.heater = true;
  yield* until(() => cb.T >= cb.Tset - 0.05, 4 * 3600);
  S.say(`${nm}：换液完成`);
}

const UNIT_RUN = { chembath: chemBathUnit, onebath: oneBathUnit, dryer: dryerUnit };

export class BathSub extends Sub {
  constructor(id, L, bus) { super(id, L, bus); this.type = BATHS[id].type; }
  channel(cmd) { return cmd === 'LIFT' ? 'lift' : 'proc'; }
  *exec(cmd, b) {
    if (cmd === 'LIFT') yield* lifterTo(this.L, this.addr, b.z);
    else if (cmd === 'RUN_UNIT') yield* UNIT_RUN[this.type](this, b.unit);
    else if (cmd === 'EXCHANGE') yield* bathExchange(this);
  }
  report() {
    const L = this.L, st = { lift: L.lift[this.addr], busy: this.jobs.length > 0 };
    if (this.addr === 'dr') st.lid = L.dr.lid;
    this.bus.status[this.addr] = st;
  }
}
