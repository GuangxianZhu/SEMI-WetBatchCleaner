// 高温药液槽（Chemical Bath）：一槽一种药。内槽溢流到外槽，循环线：外槽 → 泵 → 加热器 → 过滤器 → 内槽底部
// （[US8052833][US10928732]，作者确认）。供液（DIW、药液 1、药液 2）从上方进内槽（作者给的概要图）。
//
// 跑批时温度、浓度当作恒定（加热器把散热补回来）；药液老化、按浓度补液放到阶段 3。
// 换液（排液 → 补液 → 升温）在这里有体积、浓度、温度的动态，给管路图演示阀门和联锁用。
// 流量、加热功率、散热都是估计值（资料来源 D10）。

import { P } from './params.js';
import { zeroConc, mixByParts, SPECIES } from './chem.js';

export const CB = {
  drainLpm: 25,          // 每个排液阀
  fillLpm: { DIW: 20, C1: 12, C2: 12 },
  heaterKW: 6,
  tauLossS: 3000,        // 加热器停了以后的散热时间常数
  pumpMinOuter: 0.3,     // 外槽液位低于 30 % 不能开泵（泵会空转、吸进空气）
  // 密度 kg/L、比热 kJ/(kg·K)：SPM 按浓硫酸，SC1 按水（估计）
  rho: { SPM: 1.8, SC1: 1.0 }, cp: { SPM: 1.5, SC1: 4.0 },
};

const VALVES = ['V_DIW', 'V_C1', 'V_C2', 'V_DR', 'V_DRO'];

export class ChemBath {
  // kind：'SPM' 或 'SC1'
  constructor(kind) {
    this.kind = kind;
    this.chem = kind === 'SPM' ? ['H2SO4', 'H2O2'] : ['NH3', 'H2O2'];   // 药液 1、药液 2
    this.T = 25;
    this.Tset = 25;
    this.c = zeroConc();
    this.V = P.cbVol;           // 药液总量（内槽 + 外槽 + 管路）L
    this.contam = zeroConc();   // 带进来的杂质，mol
    this.mega = false;
    this.megaP = 0;
    this.pump = true;
    this.heater = true;
    this.valve = Object.fromEntries(VALVES.map(v => [v, false]));
    this.fillTarget = null;     // 换液时按配方算出的各路补液量 { DIW, C1, C2 } L
    this.interlockLog = [];     // 联锁动作记录
  }

  // 槽的条件（配方里药液槽单元的 cond）：SPM：H₂SO₄ : H₂O₂ = ratio : 1，温度 T；SC1：NH₄OH : H₂O₂ : H₂O = nh3 : 1 : water，温度 T
  configure(cond) {
    this.Tset = cond.T;
    this.parts = this.kind === 'SPM' ? { DIW: 0, C1: cond.ratio, C2: 1 } : { DIW: cond.water, C1: cond.nh3, C2: 1 };
    this.T = this.Tset;
    this.c = this.mixConc();
  }

  mixConc() {
    const p = this.parts;
    return mixByParts(P.stock, { [this.chem[0]]: p.C1, [this.chem[1]]: p.C2 }, p.DIW);
  }

  get innerFull() { return this.V >= P.Vliq - 1e-6; }
  get innerLevel() { return Math.min(1, this.V / P.Vliq); }
  get outerLevel() { return Math.max(0, (this.V - P.Vliq) / (P.cbVol - P.Vliq)); }
  get empty() { return this.V <= 1e-6; }

  // 换液时各路要补多少（按配方比例补满）
  planFill() {
    const p = this.parts, tot = p.DIW + p.C1 + p.C2;
    this.fillTarget = { DIW: P.cbVol * p.DIW / tot, C1: P.cbVol * p.C1 / tot, C2: P.cbVol * p.C2 / tot };
    this.filled = { DIW: 0, C1: 0, C2: 0 };
  }

  step(dt) {
    const v = this.valve;
    // 排液
    let out = 0;
    if (v.V_DR) out += CB.drainLpm / 60 * dt;
    if (v.V_DRO) out += CB.drainLpm / 60 * dt;
    out = Math.min(out, this.V);
    this.V -= out;
    // 补液：DIW、药液 1、药液 2 从上方进内槽
    const add = { DIW: 0, C1: 0, C2: 0 };
    for (const k of ['DIW', 'C1', 'C2']) if (v[`V_${k}`]) add[k] = CB.fillLpm[k] / 60 * dt;
    const addV = add.DIW + add.C1 + add.C2;
    if (addV > 0) {
      const V1 = this.V + addV;
      const n = {};
      for (const s of SPECIES) n[s] = this.c[s] * this.V;
      n[this.chem[0]] += P.stock[this.chem[0]] * add.C1;
      n[this.chem[1]] += P.stock[this.chem[1]] * add.C2;
      for (const s of SPECIES) this.c[s] = n[s] / V1;
      this.T = (this.T * this.V + 25 * addV) / V1;
      this.V = V1;
      if (this.filled) for (const k in add) this.filled[k] += add[k];
    }
    if (this.V <= 1e-6) { this.V = 0; this.c = zeroConc(); }
    // 联锁：外槽液位太低，泵停；泵停了，加热器停（没有流过加热器的液体会空烧）
    if (this.pump && this.outerLevel < CB.pumpMinOuter) { this.pump = false; this.interlockLog.push('外槽液位低，循环泵停'); }
    if (this.heater && !this.pump) { this.heater = false; this.interlockLog.push('循环泵停了，加热器停'); }
    // 温度：加热器开着就以最大功率加热到设定值（并补回散热）；停了就慢慢散热
    if (this.heater && this.V > 0) {
      const m = this.V * CB.rho[this.kind];
      const rate = CB.heaterKW / (m * CB.cp[this.kind]);   // K/s
      this.T = Math.min(this.Tset, this.T + rate * dt);
    } else {
      this.T += (25 - this.T) * (1 - Math.exp(-dt / CB.tauLossS));
    }
  }

  // 晶圆带进来的液体（从单槽来的残留）
  dragIn(volL, conc) { for (const s of SPECIES) this.contam[s] += (conc[s] || 0) * volL; }

  // 外来杂质浓度 mol/L
  contamConc(s) { return this.contam[s] / P.cbVol; }

  // 现在槽里是什么液体（给管路图标颜色）
  fluid() {
    if (this.V <= 1e-6) return null;
    const c = this.c;
    if (c[this.chem[0]] > 1e-3 && c[this.chem[1]] > 1e-3) return this.kind;
    if (c[this.chem[0]] > 1e-3) return this.chem[0];
    if (c[this.chem[1]] > 1e-3) return this.chem[1];
    return 'DIW';
  }

  label() { return this.kind; }
}
