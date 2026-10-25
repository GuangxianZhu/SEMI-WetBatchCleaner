// 减压干燥槽（Low-Pressure Dryer）：下面是水，水面上供 IPA，上面是 N₂。
// 晶圆从水里慢慢提起，穿过 IPA 层到气体层，再减压、N₂ 吹干。
//
// 模型（机理公认 [Leenaars1990]，数值都是估计）：
// - IPA 层的"强度" ipa ∈ [0, 1]：供 IPA 时按 τ = 40 s 趋近 1；停了以后 IPA 往水里扩散（和水互溶），按 τ = 300 s 变弱
// - Marangoni 能把水膜拉走的临界提拉速度 vCrit = 0.1 + 2.0 × ipa（mm/s）
// - 提得比 vCrit 快，晶圆上留下水膜，留下的比例 r = 1 − exp(−(v / vCrit − 1))
// - 缝里最后留下的液体中 IPA 的比例 ≈ ipa × (1 − r)
// 什么时候不准：真实的临界速度还和温度、IPA 浓度分布、表面状态有关；IPA 浓度梯度是三维的。

export const DRY = {
  tauIpaOn: 40, tauIpaOff: 300,
  vCrit0: 0.1, vCritIpa: 2.0,   // mm/s
  tauO2: 15, tauO2Open: 5,      // N₂ 置换、开盖回到空气
  pVac: 5, tauVac: 10, tauVent: 5,   // kPa、s
};

export class Dryer {
  constructor() {
    this.lid = 0;          // 0 开、1 关
    this.o2 = 21;          // 槽内氧浓度 %
    this.ipa = 0;
    this.ipaOn = false;
    this.n2On = false;
    this.vacOn = false;
    this.pressure = 101.3; // kPa
    this.ipaL = 0;         // IPA 用量（示意：按供给时间 0.1 L/min 计）
    this.lift = null;      // 正在慢速提拉时记录 { sumR, sumIpa, n }
  }

  vCrit() { return DRY.vCrit0 + DRY.vCritIpa * this.ipa; }

  step(dt) {
    const closed = this.lid > 0.99;
    if (closed && this.n2On) this.o2 += (0.1 - this.o2) * (1 - Math.exp(-dt / DRY.tauO2));
    else if (!closed) this.o2 += (21 - this.o2) * (1 - Math.exp(-dt / DRY.tauO2Open));
    if (this.ipaOn) { this.ipa += (1 - this.ipa) * (1 - Math.exp(-dt / DRY.tauIpaOn)); this.ipaL += dt / 600; }
    else this.ipa *= Math.exp(-dt / DRY.tauIpaOff);
    const pT = this.vacOn ? DRY.pVac : 101.3;
    this.pressure += (pT - this.pressure) * (1 - Math.exp(-dt / (this.vacOn ? DRY.tauVac : DRY.tauVent)));
  }

  // 慢速提拉的每一步：v 是提拉速度 mm/s
  liftSample(v) {
    const vc = this.vCrit();
    const r = v <= vc ? 0 : 1 - Math.exp(-(v / vc - 1));
    if (!this.lift) this.lift = { sumR: 0, sumIpa: 0, n: 0 };
    this.lift.sumR += r;
    this.lift.sumIpa += this.ipa * (1 - r);
    this.lift.n++;
  }

  // 提拉结束：留下的水膜比例 r、缝里 IPA 比例 xIpa
  liftResult() {
    const l = this.lift || { sumR: 1, sumIpa: 0, n: 1 };
    return { r: l.sumR / l.n, xIpa: l.sumIpa / l.n, o2: this.o2 };
  }
}
