// node --test sim/test/
// 测试分两类：
// - 模型自洽检查：代码和模型的推导一致（通过不代表和现实一致）
// - 量级检查：和公开数据对得上（出处见 docs/资料来源.md）
import test from 'node:test';
import assert from 'node:assert/strict';
import { resistivity, zeroConc, mixByParts } from '../chem.js';
import { OneBath } from '../onebath.js';
import { P } from '../params.js';
import { gammaMix, collapseFrac, stressGPa, SURF } from '../surface.js';
import { Line, simulate } from '../tool.js';
import { evaluate } from '../result.js';
import { PRESETS, DEFAULT } from '../recipe.js';

const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel, `${msg}: ${a} vs ${b}`);

// ---------- 量级检查 ----------
test('量级：25 °C 纯水比电阻 18.18 MΩ·cm [Light2005]', () => {
  near(resistivity(zeroConc()), 18.18, 0.005, '纯水');
});

test('量级：10⁻⁶ mol/L HCl 的比电阻约 2.3 MΩ·cm（H⁺ + Cl⁻ 完全电离，水自己的离子被压下去）', () => {
  const c = zeroConc(); c.HCl = 1e-6;
  near(resistivity(c), 1 / ((349.65 + 76.31) * 1e-6 * 1000), 0.02, 'HCl 1e-6');
});

test('量级：水和 IPA 的表面张力比约 0.30，图形应力跟着降到约 0.30 倍', () => {
  near(SURF.gammaIpa / SURF.gammaWater, 0.298, 0.01, 'γ 比');
  near(stressGPa(SURF.gammaIpa) / stressGPa(SURF.gammaWater), 0.298, 0.01, 'σ 比');
  assert.ok(collapseFrac(SURF.gammaWater) > 0.8, '水：测试图形大部分倒');
  assert.ok(collapseFrac(SURF.gammaIpa) < 0.01, 'IPA：几乎不倒');
});

test('量级：配好的 SC1 1:1:5 里 NH₃ 约 2.2 mol/L', () => {
  near(mixByParts(P.stock, { NH3: 1, H2O2: 1 }, 5).NH3, 15.3 / 7, 1e-9, 'NH3');
});

// ---------- 模型自洽检查：单槽 ----------
function runOb(ob, s, dt = 0.1) { for (let t = 0; t < s; t += dt) ob.step(dt); }

test('自洽：满槽注药，过一个 τ 浓度到目标的 63 %', () => {
  const ob = new OneBath();
  ob.supply(30, 25, { species: 'HF', ratio: 100 });
  const tau = P.Vliq / (30 / 60);
  runOb(ob, tau);
  near(ob.c.HF / ob.cin.HF, 1 - Math.exp(-1), 0.01, 'C/Cin');
});

test('自洽：∫C dt = 注入浓度 × 注入时间，和流量无关（资料来源 D4）', () => {
  for (const Lpm of [15, 30, 60]) {
    const ob = new OneBath(), dt = 0.1, tInj = 60;
    let integ = 0, t = 0;
    ob.supply(Lpm, 25, { species: 'HF', ratio: 100 });
    const cin = ob.cin.HF;
    for (; t < tInj; t += dt) { ob.step(dt); integ += ob.c.HF * dt; }
    ob.supply(Lpm, 25);
    for (; t < 6000; t += dt) { ob.step(dt); integ += ob.c.HF * dt; }
    near(integ, cin * tInj, 0.01, `流量 ${Lpm} L/min`);
  }
});

test('自洽：快排一次，浓度降到残液比例 f（不开淋浴）', () => {
  const ob = new OneBath();
  ob.c.H2SO4 = 0.1;
  ob.startDump(false);
  while (!ob.empty) ob.step(0.05);
  ob.stopDump();
  ob.supply(P.refillLpm, 25);
  while (!ob.full) ob.step(0.05);
  near(ob.c.H2SO4, 0.1 * P.qdrResidual, 0.05, '一次快排');
});

test('自洽：上流流量翻倍，冲到同一比电阻的时间减半', () => {
  const tTo = Lpm => {
    const ob = new OneBath();
    ob.c.HCl = 1e-3;
    ob.supply(Lpm, 25);
    let t = 0;
    while (resistivity(ob.c) < 15) { ob.step(0.1); t += 0.1; }
    return t;
  };
  near(tTo(60), tTo(30) / 2, 0.02, '时间');
});

test('自洽：水和 IPA 混合液的表面张力在两个纯液体之间，单调下降', () => {
  let prev = Infinity;
  for (let x = 0; x <= 1.0001; x += 0.1) { const g = gammaMix(x); assert.ok(g <= prev + 1e-9 && g >= SURF.gammaIpa - 1e-9); prev = g; }
});

// ---------- 整机 ----------
test('整机：标准配方跑完，9 项全部合格，没有违反联锁，晶圆回到原来的槽位', () => {
  const L = simulate(DEFAULT, 0.1);
  const ev = evaluate(L);
  assert.equal(L.done, true);
  assert.deepEqual(L.violations, []);
  assert.equal(L.trackingOk, true);
  assert.equal(ev.bad, 0, ev.items.filter(i => !i.ok).map(i => `${i.label} ${i.val}`).join('; '));
  assert.equal(L.batch.holder, 'foup');
  assert.equal(L.stepTimes.length, L.steps.length);
  assert.ok(L.t > 40 * 60 && L.t < 120 * 60, `总时间 ${L.t / 60} min`);
});

test('整机：四段搬送，每段在空气里约 11 s（资料来源 D6）', () => {
  const L = simulate(DEFAULT, 0.1);
  assert.equal(L.air.log.length, 4);
  for (const a of L.air.log) assert.ok(a.t > 8 && a.t < 15, `${a.from}→${a.to} ${a.t}`);
});

test('整机：夹爪搬完药液都洗过，取干片前是干的（联锁）', () => {
  const L = new Line(DEFAULT);
  let pickedDryWithWet = false;
  for (let i = 0; i < L.steps.length; i++) {
    L.startStep(i);
    while (L.busy) {
      const before = L.batch.holder;
      L.step(0.1);
      if (before === 'dr' && L.batch.holder === 'robot' && L.robot.wet) pickedDryWithWet = true;
    }
  }
  assert.equal(pickedDryWithWet, false);
  assert.deepEqual(L.violations, []);
});

test('整机：预览用的大步长和小步长结果一致', () => {
  const a = evaluate(simulate(DEFAULT, 0.1)), b = evaluate(simulate(DEFAULT, 0.5));
  for (let i = 0; i < a.items.length; i++) assert.equal(a.items[i].ok, b.items[i].ok, a.items[i].label);
});

// 每个错误配方都应该错在它该错的地方
const EXPECT = {
  std: [],
  sc1hot: ['si'],
  nomega: ['part'],
  dhflong: ['thox'],
  shortrinse: ['part'],
  noshower: ['col'],
  slow: ['part', 'wm', 'air'],
  fastlift: ['wm', 'col'],
  noipa: ['wm', 'col'],
  hfdry: [],                    // HF 放到干燥槽里：HF 之后不出液面直接干燥
  slowhfdry: ['part', 'air'],   // 搬得一样慢，但水痕没了（对比"搬得太慢"）
};
for (const p of PRESETS) {
  test(`预置配方「${p.name}」：不合格的项是 ${EXPECT[p.id].join('、') || '无'}`, () => {
    const ev = evaluate(simulate(p.r, 0.5));
    const bad = ev.items.filter(i => !i.ok).map(i => i.k).sort();
    assert.deepEqual(bad, [...EXPECT[p.id]].sort());
    assert.deepEqual(ev.violations, []);
  });
}
