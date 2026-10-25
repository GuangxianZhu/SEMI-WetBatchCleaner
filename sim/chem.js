// 稀溶液的 pH、电导率、比电阻（25 °C）。
// 做法：按电荷平衡解出 [H⁺]，再按 Kohlrausch 独立离子迁移把各离子的电导加起来。
// 假设：稀溶液（离子各自独立导电，用无限稀释的摩尔电导）；温度固定 25 °C。
// 什么时候不准：浓度高于约 0.01 mol/L 时摩尔电导会明显变小，算出的电导偏大；
// 但冲洗判终点关心的是 10⁻⁵ mol/L 以下，这一段是准的。

// 25 °C 平衡常数（公认值）
const KW = 1.008e-14;      // 水的离子积，取 [Light2005] 用的值，纯水正好 18.18 MΩ·cm
const KA_HF = 6.8e-4;      // HF ⇌ H⁺ + F⁻
const KA2_H2SO4 = 1.0e-2;  // HSO₄⁻ ⇌ H⁺ + SO₄²⁻（第一级当作完全电离）
const KA_NH4 = 5.6e-10;    // NH₄⁺ ⇌ NH₃ + H⁺

// 无限稀释摩尔电导 S·cm²/mol（25 °C，公认值；SO₄²⁻ 按每摩尔计）
const LAMBDA = { H: 349.65, OH: 198.0, F: 55.4, Cl: 76.31, HSO4: 52.0, SO4: 160.0, NH4: 73.5 };

export const SPECIES = ['HF', 'HCl', 'H2SO4', 'NH3', 'H2O2'];
export const zeroConc = () => ({ HF: 0, HCl: 0, H2SO4: 0, NH3: 0, H2O2: 0 });

// 给定 [H⁺]，算各离子浓度（mol/L）
function ions(c, h) {
  const oh = KW / h;
  const f = c.HF * KA_HF / (KA_HF + h);
  const so4 = c.H2SO4 * KA2_H2SO4 / (KA2_H2SO4 + h);
  const hso4 = c.H2SO4 - so4;
  const nh4 = c.NH3 * h / (h + KA_NH4);
  return { H: h, OH: oh, F: f, Cl: c.HCl, HSO4: hso4, SO4: so4, NH4: nh4 };
}

// 电荷平衡：正电荷 − 负电荷，随 [H⁺] 单调增加
function balance(c, h) {
  const i = ions(c, h);
  return i.H + i.NH4 - (i.OH + i.F + i.Cl + i.HSO4 + 2 * i.SO4);
}

export function solveH(c) {
  let lo = -15, hi = 1.5;   // log10[H⁺]
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (balance(c, 10 ** mid) > 0) hi = mid; else lo = mid;
  }
  return 10 ** ((lo + hi) / 2);
}

// 电导率 µS/cm：κ = Σ λᵢ·cᵢ，λ 单位 S·cm²/mol、c 单位 mol/L → ×1000 得 µS/cm
export function conductivity(c) {
  const i = ions(c, solveH(c));
  let k = 0;
  for (const key in LAMBDA) k += LAMBDA[key] * i[key];
  return k * 1000;
}

export const resistivity = c => 1 / conductivity(c);   // MΩ·cm
export const pH = c => -Math.log10(solveH(c));

// 按体积比把原液和水混合，返回各物质 mol/L。parts：{ 物质: 份数 }，water：水的份数
export function mixByParts(stock, parts, water = 0) {
  const total = Object.values(parts).reduce((a, b) => a + b, 0) + water;
  const c = zeroConc();
  for (const k in parts) c[k] = stock[k] * parts[k] / total;
  return c;
}
