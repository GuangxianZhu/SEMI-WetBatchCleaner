// 晶圆表面状态（整批平均）和各个槽对它的作用。
// 趋势是公认的；系数全部是估计值，目的是让"做对 / 做错"的差别在量级上合理，不是预测真实数值。
// 出处编号见 docs/资料来源.md。

const K_B = 8.617e-5;                     // eV/K
const arr = (Ea, T, Tref) => Math.exp(Ea / K_B * (1 / (Tref + 273.15) - 1 / (T + 273.15)));
const approach = (x, target, dt, tau) => x + (target - x) * (1 - Math.exp(-dt / tau));

export const SURF = {
  // 进来时的状态（示意）
  org0: 1, particles0: 500, fe0: 1e11, chemOx0: 1.2,
  // SPM：去有机物（120 °C 时 τ = 60 s，Ea 0.5 eV）；溶掉一部分金属；表面长一层化学氧化膜
  tauOrg: 60, TrefOrg: 120, EaOrg: 0.5,
  feEqSPM: 1e10, tauFeSPM: 120,
  oxEq: 1.0, tauOx: 30,                     // SC1 之后约 1 nm 化学氧化膜 [RCA-wiki]
  // SC1：硅被慢慢刻（1:1:5、75 °C 约 0.1 nm/min，随 NH₃ 浓度和温度上升）；把颗粒从底下掏松；Fe 会沉积 [RCA-wiki]
  siRate: 0.1, nh3Ref: 15.3 / 7, TrefSi: 75, EaSi: 0.6,
  partPerNm: 1.0,                           // 每刻掉 1 nm 硅，颗粒剩 e⁻¹
  megaRate: 2 / 600,                        // 兆声满功率时每秒的去除速率（10 min 相当于 e⁻²）
  feEqSC1: 3e10, tauFeSC1: 120,
  oxRateSC1: 0.02,                          // SC1 刻热氧化膜 nm/min
  roughPerNm: 0.05,                         // 每刻掉 1 nm 硅，粗糙度增加 nm
  // HF：热氧化膜速率 = kHF × [HF]，10:1 HF（2.56 mol/L）约 23 nm/min [Williams1996]（待核对）
  kHF: 23 / 2.56,                           // nm/min per mol/L
  chemOxFactor: 2,                          // 化学氧化膜比热氧化膜刻得快
  feOutPerNm: 2.3,                          // 氧化膜每溶掉 1 nm，嵌在里面的 Fe 剩 e^−2.3 ≈ 10 %
  // 图形倒塌（示意测试图形：线宽 20 nm、间距 30 nm、高 200 nm）
  // σ = (6γcosθ / D)(H/W)²，水、cosθ = 1 时约 1.44 GPa [Tanaka1993][Namatsu1995]
  sigmaWater: 1.44, sigma50: 1.0, sigmaSpread: 0.3,   // GPa；倒塌比例按对数正态分布（σ50 是原创示意值）
  gammaWater: 72.74, gammaIpa: 21.7,                  // mN/m，20 °C [IAPWS2014][IPA-data-wiki]
  qdrFactor: 0.4,                                     // 快排时不开淋浴，弯月面扫过图形的应力约为完全干燥时的 0.4 倍
  // 空气暴露（资料来源 D6）
  airDryCb: 30, airPartPerS: 4,             // 带着药液在空气里超过 30 s，局部变干留下残留
  airDewetHf: 15, airWmPerS: 40 / 30,       // HF 之后的疏水面在空气里超过 15 s 开始长水痕
  // 干燥
  dryWm: 60,                                // 留下的水膜全部变成水痕时的个数（每片，示意）
  // 冲洗不干净就去药液槽：带进去的杂质变成盐粒（例如 (NH₄)₂SO₄）
  carryPartPerSqrtMmol: 200,
};

// 标准正态分布函数
function Phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// 水和 IPA 混合液的表面张力（示意曲线：少量 IPA 就让表面张力下降很多；阶段 3 换成 [Vazquez1995] 的数据）
export function gammaMix(xIpa) {
  const x = Math.min(1, Math.max(0, xIpa));
  return SURF.gammaWater - (SURF.gammaWater - SURF.gammaIpa) * Math.pow(x, 0.3);
}

// 某个表面张力下，测试图形倒掉的比例
export function collapseFrac(gamma, factor = 1) {
  const sigma = SURF.sigmaWater * gamma / SURF.gammaWater * factor;
  return Phi(Math.log(sigma / SURF.sigma50) / SURF.sigmaSpread);
}
export const stressGPa = (gamma, factor = 1) => SURF.sigmaWater * gamma / SURF.gammaWater * factor;

export class Surface {
  constructor() {
    this.org = SURF.org0;           // 有机物（相对值）
    this.particles = SURF.particles0;   // 颗粒 个/片（> 30 nm，示意）
    this.fe = SURF.fe0;             // Fe atoms/cm²
    this.chemOx = SURF.chemOx0;     // 化学氧化膜 / 自然氧化膜 nm
    this.thermOxLoss = 0;           // 热氧化膜损失 nm
    this.siLoss = 0;                // 硅损失 nm
    this.rough = 0.1;               // 粗糙度 Ra nm
    this.hTerm = false;             // H 终端（疏水）
    this.watermarks = 0;            // 水痕 个/片
    this.collapse = 0;              // 测试图形倒塌比例
    this.megaDose = 0;
    this.dry = true;                // 进设备时是干的
    this.carryMmol = 0;             // 冲洗不净带进药液槽的杂质 mmol
    this.liquidGamma = null;        // 当前缝里液体的表面张力（给界面用）
  }

  addCollapse(p) { this.collapse = 1 - (1 - this.collapse) * (1 - p); }

  inSPM(dt, T) {
    this.dry = false;
    this.org *= Math.exp(-dt / (SURF.tauOrg / arr(SURF.EaOrg, T, SURF.TrefOrg)));
    this.fe = approach(this.fe, Math.min(this.fe, SURF.feEqSPM), dt, SURF.tauFeSPM);
    this.chemOx = approach(this.chemOx, SURF.oxEq, dt, SURF.tauOx);
    this.hTerm = false;
    this.liquidGamma = SURF.gammaWater * 0.85;
  }

  inSC1(dt, bath) {
    this.dry = false;
    const r = SURF.siRate * (bath.c.NH3 / SURF.nh3Ref) * arr(SURF.EaSi, bath.T, SURF.TrefSi) / 60;   // nm/s
    const dSi = r * dt;
    this.siLoss += dSi;
    this.rough += SURF.roughPerNm * dSi;
    const mega = bath.mega ? bath.megaP : 0;
    this.megaDose += mega * dt;
    this.particles *= Math.exp(-(SURF.partPerNm * dSi + SURF.megaRate * mega * dt));
    this.fe = approach(this.fe, SURF.feEqSC1, dt, SURF.tauFeSC1);
    this.chemOx = approach(this.chemOx, SURF.oxEq, dt, SURF.tauOx);
    this.thermOxLoss += SURF.oxRateSC1 / 60 * dt;
    this.hTerm = false;
    this.liquidGamma = SURF.gammaWater * 0.9;
  }

  // 单槽里：HF 刻氧化膜（刻蚀量 = ∫速率 dt，资料来源 D4）；有 H₂O₂ 时氧化膜长回来
  inOneBath(dt, c) {
    this.dry = false;
    const rTh = SURF.kHF * c.HF / 60;           // nm/s
    this.thermOxLoss += rTh * dt;
    if (this.chemOx > 0) {
      const d = Math.min(this.chemOx, rTh * SURF.chemOxFactor * dt);
      this.chemOx -= d;
      this.fe *= Math.exp(-SURF.feOutPerNm * d);
      if (this.chemOx < 0.02) { this.chemOx = 0; this.hTerm = true; }
    }
    if (c.H2O2 > 1e-3 && c.HF < 1e-4) { this.chemOx = approach(this.chemOx, SURF.oxEq, dt, SURF.tauOx); if (this.chemOx > 0.05) this.hTerm = false; }
    this.liquidGamma = SURF.gammaWater;
  }

  // 快排排空时晶圆露出液面
  qdrExposed(shower) {
    if (!shower) this.addCollapse(collapseFrac(SURF.gammaWater, SURF.qdrFactor));
  }

  // 在空气里待了 t 秒后重新浸入。from：'cb'（带着药液）/ 'ob'（带着水）
  airExposure(t, from) {
    if (from === 'cb' && t > SURF.airDryCb) this.particles += (t - SURF.airDryCb) * SURF.airPartPerS;
    if (from === 'ob' && this.hTerm && t > SURF.airDewetHf) this.watermarks += (t - SURF.airDewetHf) * SURF.airWmPerS;
  }

  // 冲洗不干净就进了药液槽：带进去的杂质变成盐粒
  carryInto(mmol) {
    this.carryMmol += mmol;
    if (mmol > 1e-3) this.particles += SURF.carryPartPerSqrtMmol * Math.sqrt(mmol);
  }

  // 干燥结束：r 留下的水膜比例，xIpa 缝里 IPA 比例，o2 槽内氧 %
  applyDrying({ r, xIpa, o2 }, vacuum) {
    const o2f = 0.1 + 0.9 * o2 / 21;
    this.watermarks += r * (this.hTerm ? 1 : 0.15) * o2f * SURF.dryWm * (vacuum ? 1 : 1.3);
    const g = gammaMix(xIpa);
    this.addCollapse(collapseFrac(g));
    this.liquidGamma = g;
    this.dry = true;
  }
}
