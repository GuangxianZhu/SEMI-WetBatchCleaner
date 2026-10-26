// 配方三层（流程 → 单元 → 步骤）：结构对，改了单元里的步骤，模拟跟着变（sim/recipe.js）
import test from 'node:test';
import assert from 'node:assert/strict';
import { Line, simulate } from '../tool.js';
import { DEFAULT, PRESETS, BATHS, STEP_KINDS, newStep, cloneRecipe, describeSteps } from '../recipe.js';
import { evaluate } from '../result.js';

const badItems = r => evaluate(simulate(r, 0.5)).items.filter(i => !i.ok).map(i => i.k).sort();

test('标准流程：五个单元按 药液槽 1 → 单槽 1 → 药液槽 2 → 单槽 2 → 减压干燥槽 排；每一步的种类和槽对得上', () => {
  assert.deepEqual(DEFAULT.flow.units.map(id => DEFAULT.units[id].bath), ['cb1', 'ob1', 'cb2', 'ob2', 'dr']);
  for (const p of PRESETS) for (const u of Object.values(p.r.units)) {
    for (const s of u.steps) assert.ok(STEP_KINDS[s.kind].baths.includes(BATHS[u.bath].type), `${p.id} ${u.name} ${s.kind}`);
  }
  const L = new Line(DEFAULT);
  assert.equal(L.steps.length, 3 + 5 + 1);
  assert.deepEqual(L.steps.slice(3, 8).map(s => s.focus), ['cb1', 'ob1', 'cb2', 'ob2', 'dr']);
  assert.match(L.steps[6].now, /DHF|HF 1 : 100/);
  assert.match(describeSteps(DEFAULT.units.rinse1.steps), /快排冲洗（补水 70 °C） ×2/);
});

test('跑完一批：单元里每一步都有开始和结束时间，按顺序；配方本身没被改动', () => {
  const R = cloneRecipe(DEFAULT);
  const L = simulate(R, 0.5);
  const want = DEFAULT.flow.units.flatMap(id => DEFAULT.units[id].steps.map((s, i) => `${id}#${i}:${s.kind}`));
  assert.deepEqual(L.stepLog.map(r => `${r.unit}#${r.i}:${r.kind}`), want);
  for (let k = 0; k < L.stepLog.length; k++) {
    const r = L.stepLog[k];
    assert.ok(r.t1 >= r.t0, `${r.unit}#${r.i}`);
    if (k) assert.ok(r.t0 >= L.stepLog[k - 1].t1 - 1e-9, '一步接一步');
  }
  // 浸泡步骤的时间就是设定的时间
  const soak = L.stepLog.find(r => r.unit === 'spm');
  assert.ok(Math.abs(soak.t1 - soak.t0 - 600) < 0.6);
  assert.deepEqual(R, DEFAULT);
});

test('改单元：去掉单槽 2 的注药（DHF），化学氧化膜去不掉，只错在这一项（和 Fe）', () => {
  const R = cloneRecipe(DEFAULT);
  R.units.dhf.steps = R.units.dhf.steps.filter(s => s.kind !== 'inject');
  assert.deepEqual(badItems(R), ['fe', 'ox']);
});

test('改单元：单槽 1 多加一次快排，快排次数跟着变；药液槽条件改了，槽的设定温度跟着变', () => {
  const R = cloneRecipe(DEFAULT);
  R.units.rinse1.steps.unshift(newStep('qdr'));
  R.units.spm.cond.T = 100;
  const L = simulate(R, 0.5);
  assert.equal(L.stepLog.filter(r => r.unit === 'rinse1' && r.kind === 'qdr').length, 4);
  assert.equal(L.cb1.Tset, 100);
});

test('改单元：兆声只开前一半时间，颗粒介于"一直开"和"不开"之间', () => {
  const half = cloneRecipe(DEFAULT);
  half.units.sc1.steps = [{ ...newStep('soak'), s: 300, mega: 100 }, { ...newStep('soak'), s: 300, mega: 0 }];
  const p = r => evaluate(simulate(r, 0.5)).items.find(i => i.k === 'part').val;
  const num = v => parseFloat(v);
  const std = num(p(DEFAULT)), none = num(p(PRESETS.find(x => x.id === 'nomega').r)), mid = num(p(half));
  assert.ok(std < mid && mid < none, `${std} < ${mid} < ${none}`);
});

test('干燥单元：去掉 N₂ 置换，IPA 时氧没降下来 → 报联锁；去掉提拉步骤 → 按 1 mm/s 补一次提拉，照样走完', () => {
  const noPurge = cloneRecipe(DEFAULT);
  noPurge.units.dry.steps = noPurge.units.dry.steps.filter(s => s.kind !== 'purge');
  const L1 = simulate(noPurge, 0.5);
  assert.ok(L1.violations.some(v => /氧浓度没降下来就供 IPA/.test(v.msg)));

  const noLift = cloneRecipe(DEFAULT);
  noLift.units.dry.steps = noLift.units.dry.steps.filter(s => s.kind !== 'lift');
  const L2 = simulate(noLift, 0.5);
  assert.ok(L2.done);
  assert.deepEqual(L2.violations, []);
  assert.ok(L2.notes.some(n => /没有"慢速提拉"/.test(n)));
});
