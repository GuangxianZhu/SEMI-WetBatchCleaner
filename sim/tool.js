// 整机：装载区 → 药液槽 1（SPM）→ 单槽 1 → 药液槽 2（SC1）→ 单槽 2（DHF）→ 减压干燥槽 → 装载区。
// 槽间搬送机械手一台走全线；每个槽有自己的升降器，只在槽内上下；搬完药液、以及取干片之前，机械手先去夹爪清洗干燥位。
// 配方是"流程 → 单元 → 步骤"三层（sim/recipe.js）。
//
// 软件分成主控和子控（docs/软件结构.md）：
//   主控 sim/main.js：按配方排计划、调度、晶圆追踪、跨模块联锁（真机在 Windows PC 上，和画面在一起）
//   子控 sim/subs.js：装载、搬送、各个槽的执行（真机在 Linux PC 上）
//   通信 sim/bus.js：命令 / 做完 / 报警 / 过程记录 / 状态
// 这个文件是"机台本身"：设备对象、晶圆带液、空气暴露这些物理，以及把主控、子控、通信接起来。
// 写法：动作都是生成器，每 yield 一次消耗一个时间步，step(dt) 用 next(dt) 推进。纯计算，不碰界面，node 里能直接跑。

import { P, TANKS, STATION_NAME } from './params.js';
import { OneBath } from './onebath.js';
import { ChemBath } from './chembath.js';
import { Dryer } from './dryer.js';
import { Surface } from './surface.js';
import { DEFAULT, cloneRecipe, unitOfBath, recipeFacts } from './recipe.js';
import { SPECIES } from './chem.js';
import { buildGraph, chemBathTemplate, oneBathTemplate, dryerTemplate, computeFlows, chemBathState, oneBathState, dryerState, checkInterlocks } from './piping.js';
import { Bus } from './bus.js';
import { Main, lineSteps } from './main.js';
import { LoaderSub, TransferSub, BathSub } from './subs.js';

// 管路（药液槽、单槽、减压干燥槽的模板，见 docs/管路.md；夹爪清洗干燥位以后再做）
export const PIPING = buildGraph([chemBathTemplate('cb1', 'SPM'), oneBathTemplate('ob1'), chemBathTemplate('cb2', 'SC1'), oneBathTemplate('ob2'), dryerTemplate('dr')]);

const NAME = STATION_NAME;
const isCb = id => id === 'cb1' || id === 'cb2';
const isOb = id => id === 'ob1' || id === 'ob2';

// ---------- 整机 ----------
export class Line {
  constructor(recipe = DEFAULT) {
    this.R = cloneRecipe(recipe);
    this.facts = recipeFacts(this.R);
    this.steps = lineSteps(this.R);     // 主控的计划：这一批的工艺步骤（按流程排出来）
    this.t = 0;
    this.robot = { x: P.X.loader, chuck: 1, holding: false, wet: false, chem: null, moving: false, task: '待机' };
    this.lift = { cb1: 0, ob1: 0, cb2: 0, ob2: 0, dr: 0 };   // 空着时停在下面，要交接时才升上来
    this.batch = { holder: 'foup' };   // foup / pick / posture / robot / cb1 / ob1 / cb2 / ob2 / dr
    this.loader = { door: 0, map: 0, pick1: 0, pick2: 0, posture: 0 };
    // 药液槽的条件来自流程里用这个槽的单元
    this.cb1 = new ChemBath('SPM'); this.cb1.configure((unitOfBath(this.R, 'cb1') || DEFAULT.units.spm).cond);
    this.cb2 = new ChemBath('SC1'); this.cb2.configure((unitOfBath(this.R, 'cb2') || DEFAULT.units.sc1).cond);
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
    this.stepLog = [];                 // 单元里每一步的开始、结束时间（配方页显示实际用了多久）
    this.stepIdx = -1; this.runner = null; this.stepT0 = 0; this.stepTimes = [];
    this.phase = '';
    this.task = null; this.lastTask = null; this.batchT0 = 0;
    this.done = false;
    // 晶圆追踪：批里第 b 片来自哪个 FOUP 的哪个槽位（两盒交错合批）
    this.origin = Array.from({ length: P.nWafer }, (_, b) => ({ foup: 1 + (b % 2), slot: Math.floor(b / 2) }));
    this.trackingOk = null;
    // 主控、子控、通信
    this.bus = new Bus(() => this.t);
    this.main = new Main(this, this.bus);
    this.subs = [new LoaderSub(this, this.bus), new TransferSub(this, this.bus), ...TANKS.map(id => new BathSub(id, this, this.bus))];
    for (const s of this.subs) s.report();
  }

  get busy() { return !!this.runner; }

  // 晶圆真的换了地方（子控交接、取放片时调用）：放进槽里时，带过来的液体混进去
  moveWafers(from, to) {
    this.batch.holder = to;
    if (TANKS.includes(to)) this.applyCarry(to);
  }

  violate(msg) { this.violations.push({ t: this.t, msg }); }

  // 维护动作（例如换液）：不算工艺步骤，没在跑批时才能做
  get canMaintain() { return !this.busy && (this.stepIdx < 0 || this.done); }
  startExchange(id) {
    if (!this.canMaintain) return false;
    this.task = `${NAME[id]} 换液`;
    this.runner = this.main.exchange(id);
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
    dryerState('dr', this.dr, state);
    const { flows, blocked } = computeFlows(PIPING, state);
    return { state, flows, blocked, bad: checkInterlocks(PIPING, state, flows, blocked) };
  }

  startStep(i) {
    this.task = null;
    if (i === 0) this.batchT0 = this.t;   // 这一批从这里开始计时（前面可能做过换液）
    this.stepIdx = i;
    this.stepT0 = this.t;
    this.runner = this.steps[i].run(this.main);
    this.runner.next(0);
  }

  step(dt) {
    this.t += dt;
    this.cb1.step(dt); this.cb2.step(dt);
    this.ob1.step(dt); this.ob2.step(dt); this.dr.step(dt);
    for (const s of this.subs) s.advance(dt);      // 子控：各自的作业往前走
    if (this.runner && this.runner.next(dt).done) {
      this.runner = null;
      if (this.task) { this.lastTask = this.task; this.task = null; }
      else {
        this.stepTimes[this.stepIdx] = this.t - this.stepT0;
        if (this.stepIdx === this.steps.length - 1) this.done = true;
      }
    }
    this.updateWafers(dt);
  }

  // 一口气跑完全部步骤（测试和配方页的预览用）
  runAll(dt = 0.1) {
    for (let i = 0; i < this.steps.length; i++) {
      this.startStep(i);
      while (this.busy) this.step(dt);
    }
    while (this.subs.some(s => s.jobs.length)) this.step(dt);   // 等后台作业（例如空升降器降回去）做完
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
    if (id === 'dr') this.dr.liq.addLiquid(P.dragOutL, k.c, k.T);
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
      else if (tank === 'dr') this.surf.inOneBath(dt, this.dr.liq.c);   // 干燥槽的水（干净的 DIW 不改变表面；注了 HF 就刻）
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
      diwL: this.ob1.diwL + this.ob2.diwL + this.dr.liq.diwL,
      hfL: (this.ob2.chemL.HF || 0) + (this.dr.liq.chemL.HF || 0),
      ipaL: this.dr.ipaL,
      dragL: 2 * P.dragOutL,
    };
  }
}

// 按配方从头到尾跑一遍（配方页预览用；步长大一点，几十毫秒跑完）
export function simulate(recipe, dt = 0.25) { return new Line(recipe).runAll(dt); }
