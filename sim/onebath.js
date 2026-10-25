// 单槽（One-Bath）：底部进液、顶部溢流、快排冲洗（QDR）、淋浴、在线注药。
// 模型：完全混合槽（CSTR）。槽满时进多少溢多少；快排时几秒内排到只剩残液（比例 f，资料来源 D2）。
// 什么时候不准：真实槽有死区、热液上浮分层，上流更接近活塞流，实际置换比这里慢。

import { P } from './params.js';
import { zeroConc, SPECIES, resistivity } from './chem.js';

export class OneBath {
  constructor() {
    this.V = P.Vliq;          // 液体体积 L
    this.c = zeroConc();      // 各物质 mol/L
    this.T = P.coldC;         // °C
    this.Q = 0;               // 供液流量 L/min（含注入的药液）
    this.Tin = P.coldC;
    this.cin = zeroConc();    // 供液浓度
    this.inject = null;       // { species, ratio }：按 1 : ratio 把原液注进 DIW
    this.dumping = false;
    this.shower = false;
    this.refillShower = false;
    this.rho = resistivity(this.c);
    this.rhoAcc = 0;
    this.diwL = 0;            // 累计 DIW 用量
    this.chemL = {};          // 累计原液用量 { species: L }
    this.showerActive = false;
    this.cleanS = 0;          // 溢流出去的水已经干净了多久（排液切回收用，见 sim/piping.js）
  }

  get level() { return this.V / P.Vliq; }
  get full() { return this.V >= P.Vliq - 1e-6; }
  get empty() { return this.V <= P.Vliq * P.qdrResidual + 1e-6; }
  get supplying() { return this.Q > 0; }

  // 开始供液。inject：{ species: 'HF', ratio: 100 } 表示原液 : DIW = 1 : 100；
  // showerUntilCovered：快排后补水时淋浴继续喷，直到晶圆重新浸没
  supply(Lpm, Tin = P.coldC, inject = null, showerUntilCovered = false) {
    this.Q = Lpm;
    this.Tin = Tin;
    this.inject = inject;
    this.refillShower = showerUntilCovered;
    this.cin = zeroConc();
    if (inject) this.cin[inject.species] = P.stock[inject.species] / (inject.ratio + 1);
  }
  stop() { this.Q = 0; this.inject = null; this.cin = zeroConc(); this.refillShower = false; }

  startDump(shower) { this.dumping = true; this.shower = shower; this.stop(); }
  stopDump() { this.dumping = false; this.shower = false; }

  // 带进来的液体（比如晶圆从药液槽带出的药液）：混进槽里，多出来的从溢流口走
  addLiquid(volL, conc, T) {
    const V1 = this.V + volL;
    for (const s of SPECIES) this.c[s] = (this.c[s] * this.V + (conc[s] || 0) * volL) / V1;
    this.T = (this.T * this.V + T * volL) / V1;
    this.V = Math.min(V1, P.Vliq);
    this.rho = resistivity(this.c);
  }

  step(dt) {
    const Vres = P.Vliq * P.qdrResidual;
    // 补水时的淋浴水全部落进槽里，算进供液
    const refillShower = this.refillShower && this.level < 0.9 ? P.showerLpm / 60 : 0;
    const qSup = this.Q / 60 + refillShower;                    // L/s
    const qShower = this.dumping && this.shower ? P.showerLpm / 60 : 0;
    const qShowerMix = qShower * P.showerMix;                   // 排空时真正混进残液的那部分
    this.showerActive = qShower > 0 || refillShower > 0;

    // 用量
    const chemFrac = this.inject ? 1 / (this.inject.ratio + 1) : 0;
    this.diwL += (qSup * (1 - chemFrac) + qShower) * dt;
    if (this.inject) this.chemL[this.inject.species] = (this.chemL[this.inject.species] || 0) + qSup * chemFrac * dt;

    const qIn = qSup + qShowerMix;
    const TinMix = qIn > 0 ? (qSup * this.Tin + qShowerMix * P.coldC) / qIn : this.Tin;
    const cinMix = s => (qIn > 0 ? qSup * this.cin[s] / qIn : 0);

    if (this.dumping) {
      // 快排：排出去的是槽里的混合液（浓度不变），浓度只被进水稀释；排到残液为止。
      // 排空以后淋浴的水和残液混合，多出来的马上从排液口走，体积保持在残液量。
      const qOut = P.Vliq / P.dumpS;
      const Vleft = Math.max(Vres, this.V - qOut * dt);
      const add = qIn * dt;
      const V1 = Vleft + add;
      for (const s of SPECIES) this.c[s] = (this.c[s] * Vleft + cinMix(s) * add) / V1;
      this.T = (this.T * Vleft + TinMix * add) / V1;
      this.V = Vleft <= Vres ? Vres : V1;
    } else if (this.full) {
      // 槽满溢流，体积不变：按指数精确更新，大步长也稳定
      const k = qIn > 0 ? 1 - Math.exp(-qIn * dt / this.V) : 0;
      for (const s of SPECIES) this.c[s] += (cinMix(s) - this.c[s]) * k;
      this.T += (TinMix - this.T) * k;
    } else if (qIn > 0) {
      // 补液：体积增加
      const V1 = Math.min(P.Vliq, this.V + qIn * dt);
      const dV = V1 - this.V;
      for (const s of SPECIES) this.c[s] = (this.c[s] * this.V + cinMix(s) * dV) / V1;
      this.T = (this.T * this.V + TinMix * dV) / V1;
      this.V = V1;
    }
    // 自然散热
    this.T += (P.ambientC - this.T) * (1 - Math.exp(-dt / P.tauLossS));

    this.rhoAcc += dt;
    if (this.rhoAcc >= P.rhoEveryS) { this.rhoAcc = 0; this.rho = resistivity(this.c); }
    // 满槽在溢流、而且槽里已经是干净的 DIW：计时；快排、停止供液、变脏都从头算
    this.cleanS = !this.dumping && this.full && qIn > 0 && this.fluid() === 'DIW' ? this.cleanS + dt : 0;
  }

  // 槽里主要的药（给界面配颜色、显示用）
  mainSpecies() {
    let best = null, v = 1e-9;
    for (const s of SPECIES) if (this.c[s] > v) { v = this.c[s]; best = s; }
    return best;
  }

  // 现在槽里算什么液体（管路图配颜色、排液分流用；分界是原创的）：
  //   主要的药 ≥ 1 mmol/L → 叫药的名字（HF、H2SO4 …）
  //   药 < 1 µmol/L 而且比电阻 ≥ P.reclaimRho → DIW（干净，可以回收）
  //   中间 → 冲洗水：主要是氨水叫 RK（碱性），其余叫 RA（酸性，按酸排液处理）
  fluid() {
    if (this.V <= 1e-6) return null;
    const s = this.mainSpecies();
    const c = s ? this.c[s] : 0;
    if (c >= 1e-3) return s;
    if (c < 1e-6 && this.rho >= P.reclaimRho) return 'DIW';
    return s === 'NH3' ? 'RK' : 'RA';
  }
}
