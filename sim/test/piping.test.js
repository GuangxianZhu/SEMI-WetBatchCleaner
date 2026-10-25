// 管路：拓扑完整、流向和流程一致、联锁不被违反（docs/管路.md）
import test from 'node:test';
import assert from 'node:assert/strict';
import { Line, PIPING } from '../tool.js';
import { ChemBath, CB } from '../chembath.js';
import { OneBath } from '../onebath.js';
import { P } from '../params.js';
import { DEFAULT, PRESETS } from '../recipe.js';
import { computeFlows, checkInterlocks, oneBathState } from '../piping.js';

const flowing = (fl, a, b) => fl[`${a}>${b}`];
const CIRC = id => [[`${id}.OUT`, `${id}.PUMP`], [`${id}.PUMP`, `${id}.HTR`], [`${id}.HTR`, `${id}.FLT`], [`${id}.FLT`, `${id}.IN`]];

test('拓扑：管段端点都存在、编号不重复；每个阀、泵、加热器、过滤器、混合块……都有进有出；没有孤立的元件', () => {
  const PASS = ['valve', 'pump', 'heater', 'filter', 'mixer', 'unit', 'junction', 'nozzle', 'basin'];
  for (const id in PIPING.nodes) {
    const n = PIPING.nodes[id], i = PIPING.inn[id].length, o = PIPING.out[id].length;
    if (PASS.includes(n.kind)) assert.ok(i > 0 && o > 0, id);
    if (/^(cb|ob)/.test(id) && n.kind !== 'device') assert.ok(i + o > 0, `${id} 孤立`);
  }
  const ids = PIPING.edges.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('静止时：单槽的阀全关、没有管在流', () => {
  const { state, flows } = new Line(DEFAULT).piping();
  for (const v in state.open) if (v.startsWith('ob')) assert.equal(state.open[v], false, v);
  for (const e in flows) assert.ok(!e.startsWith('ob'), e);
});

test('跑批时：循环线和溢流在流，供液、排液不流，没有联锁问题', () => {
  const L = new Line(DEFAULT);
  const { flows, bad } = L.piping();
  for (const id of ['cb1', 'cb2']) {
    const fluid = id === 'cb1' ? 'SPM' : 'SC1';
    for (const [a, b] of CIRC(id)) assert.equal(flowing(flows, a, b), fluid, `${a}→${b}`);
    assert.equal(flowing(flows, `${id}.IN`, `${id}.OUT`), fluid, '溢流');
    assert.equal(flowing(flows, `${id}.IN`, `${id}.V_DR`), undefined, '排液');
    assert.equal(flowing(flows, `${id}.V_DIW`, `${id}.IN`), undefined, '供液');
  }
  assert.deepEqual(bad, []);
});

for (const [id, kind, sink] of [['cb1', 'SPM', 'sink.acid'], ['cb2', 'SC1', 'sink.alk']]) {
  test(`换液 ${id}（${kind}）：排液走${sink === 'sink.acid' ? '酸' : '碱'}排液、补液走对的管、泵停加热器必停，最后浓度和温度回到配方`, () => {
    const L = new Line(DEFAULT);
    assert.equal(L.startExchange(id), true);
    const cb = L[id];
    const seen = new Set();
    while (L.busy) {
      L.step(0.5);
      const { flows, bad } = L.piping();
      assert.deepEqual(bad, [], L.phase);
      assert.ok(!(cb.heater && !cb.pump), '加热器开着时泵必须在转');
      if (cb.valve.V_DR && !cb.empty) {
        seen.add('drain');
        assert.equal(flowing(flows, `${id}.V_DR`, sink), kind);
        for (const [a, b] of CIRC(id)) assert.equal(flowing(flows, a, b), undefined, '排液时循环线不流');
      }
      if (cb.valve.V_DIW) { seen.add('diw'); assert.ok(flowing(flows, 'src.DIW', `${id}.V_DIW`)); }
      if (cb.valve.V_C1) { seen.add('c1'); assert.ok(flowing(flows, `src.${cb.chem[0]}`, `${id}.V_C1`)); }
      if (cb.valve.V_C2) { seen.add('c2'); assert.ok(flowing(flows, `src.${cb.chem[1]}`, `${id}.V_C2`)); }
    }
    assert.ok(seen.has('drain') && seen.has('c1') && seen.has('c2'));
    if (kind === 'SC1') assert.ok(seen.has('diw'));
    const want = cb.mixConc();
    for (const s of cb.chem) assert.ok(Math.abs(cb.c[s] - want[s]) / want[s] < 0.02, `${s} ${cb.c[s]} vs ${want[s]}`);
    assert.ok(Math.abs(cb.V - P.cbVol) < 0.5, `体积 ${cb.V}`);
    assert.ok(cb.T >= cb.Tset - 0.1 && cb.pump && cb.heater);
    assert.equal(L.task, null);
    assert.equal(L.lastTask, `药液槽 ${id === 'cb1' ? 1 : 2} 换液`);
  });
}

test('联锁：外槽液位太低时泵停，泵停时加热器停', () => {
  const cb = new ChemBath('SPM');
  cb.configure(DEFAULT);
  cb.V = P.Vliq + (P.cbVol - P.Vliq) * (CB.pumpMinOuter - 0.05);
  cb.step(0.1);
  assert.equal(cb.pump, false);
  assert.equal(cb.heater, false);
});

test('跑批中不能换液', () => {
  const L = new Line(DEFAULT);
  L.startStep(0);
  assert.equal(L.startExchange('cb1'), false);
});

// ---------- 单槽 ----------
const OVF = id => [`${id}.TANK>${id}.PAN#L`, `${id}.TANK>${id}.PAN#R`];
const SINK_OF = { V_DA: 'sink.acid', V_DK: 'sink.alk', V_DREC: 'sink.reclaim' };
const drainTo = (fl, id) => Object.keys(SINK_OF).filter(v => fl[`${id}.${v}>${SINK_OF[v]}`]).map(v => SINK_OF[v]);

// 整批跑一遍，每 0.5 s 检查一次管路；返回看到的情况
function runBatch(recipe, each) {
  const L = new Line(recipe);
  for (let i = 0; i < L.steps.length; i++) {
    L.startStep(i);
    while (L.busy) { L.step(0.5); each(L, L.piping()); }
  }
  return L;
}

test('单槽，标准配方整批：快排、溢流、注药都走对的管，排液分流跟着槽里的液体切，没有联锁问题', () => {
  const seen = { ob1: new Set(), ob2: new Set() };
  runBatch(DEFAULT, (L, { state, flows, bad }) => {
    assert.deepEqual(bad, [], `${(L.t / 60).toFixed(1)} min ${L.phase}`);
    for (const id of ['ob1', 'ob2']) {
      const ob = L[id], k = s => `${id}.${s}`, to = drainTo(flows, id);
      assert.ok(to.length <= 1, '同时只走一路');
      if (flows[`${k('V_DREC')}>sink.reclaim`]) assert.equal(flows[`${k('V_DREC')}>sink.reclaim`], 'DIW', '回收只收干净的 DIW');
      if (ob.dumping) {
        seen[id].add('qdr');
        assert.ok(flows[`${k('TANK')}>${k('V_QDR')}`] && flows[`${k('V_QDR')}>${k('PAN')}`], '快排进接液槽');
        assert.equal(to.length, 1, '快排时排液分流开着');
        if (state.open[k('V_SH')]) { seen[id].add('shower'); assert.ok(flows[`${k('V_SH')}>${k('NOZ')}`]); }
      }
      if (ob.full && ob.Q > 0) for (const e of OVF(id)) assert.ok(flows[e], '满槽供液时两侧都在溢流');
      if (!ob.full) for (const e of OVF(id)) assert.equal(flows[e], undefined, '没满不溢流');
      if (flows[`${k('MIX')}>${k('TANK')}`] === 'HDIW') seen[id].add('hot');
      if (ob.dumping) assert.ok(!to.includes('sink.reclaim'), '快排不进回收');
      if (to.includes('sink.reclaim')) assert.ok(ob.cleanS >= P.reclaimDelayS, '干净以后溢流够久才切回收');
      if (ob.inject && ob.inject.species === 'HF') {
        seen[id].add('hf');
        assert.ok(flows[`src.HF>${k('V_HF')}`] && flows[`src.DIW>${k('V_CDIW')}`], '注 HF 时 DIW 也在流');
        assert.equal(flows[`${k('MIX')}>${k('TANK')}`], 'HF');
        assert.deepEqual(to, ['sink.acid']);
      }
      for (const s of to) seen[id].add(s);
    }
  });
  assert.deepEqual([...seen.ob1].sort(), ['hot', 'qdr', 'shower', 'sink.acid', 'sink.reclaim']);
  assert.deepEqual([...seen.ob2].sort(), ['hf', 'qdr', 'shower', 'sink.acid', 'sink.alk', 'sink.reclaim']);
});

test('单槽：开始注 HF 的那一刻（槽里还是干净的 DIW）排液已经切到酸排液', () => {
  const L = new Line(DEFAULT);
  let checked = false;
  for (let i = 0; i < L.steps.length && !checked; i++) {
    L.startStep(i);
    while (L.busy && !checked) {
      const before = L.ob2.fluid(), was = !!L.ob2.inject;
      L.step(0.1);
      if (L.ob2.inject && !was) {            // 这一步刚开始注 HF
        assert.equal(before, 'DIW');
        const { flows, bad } = L.piping();
        assert.deepEqual(drainTo(flows, 'ob2'), ['sink.acid']);
        assert.deepEqual(bad, []);
        checked = true;
      }
    }
  }
  assert.ok(checked, '标准配方里有注 HF 的步骤');
});

test('单槽，快排不开淋浴：淋浴阀一直不开，其余照样没有联锁问题', () => {
  const R = PRESETS.find(p => p.id === 'noshower').r;
  runBatch(R, (L, { state, bad }) => {
    assert.deepEqual(bad, []);
    assert.ok(!state.open['ob1.V_SH'] && !state.open['ob2.V_SH']);
  });
});

test('单槽联锁：分流切错、全关、开两路，酸碱同注，注药没有 DIW，都报出来', () => {
  // 单槽 2 正在注 HF（满槽溢流）
  const ob = new OneBath();
  ob.supply(30, P.coldC, { species: 'HF', ratio: 100 });
  ob.step(1);
  const check = mutate => {
    const state = oneBathState('ob2', ob, { open: {}, run: {}, tank: {} });
    mutate(state.open);
    const { flows, blocked } = computeFlows(PIPING, state);
    return checkInterlocks(PIPING, state, flows, blocked).join('\n');
  };
  assert.equal(check(() => {}), '');
  assert.match(check(o => { o['ob2.V_DA'] = false; o['ob2.V_DREC'] = true; }), /HF 流进了DIW 回收/);
  assert.match(check(o => { o['ob2.V_DA'] = false; }), /接液槽有液体进来，但排液阀全关/);
  assert.match(check(o => { o['ob2.V_DK'] = true; }), /排液同时走了 2 路/);
  assert.match(check(o => { o['ob2.V_NH3'] = true; }), /酸和碱的注入阀同时开着/);
  assert.match(check(o => { o['ob2.V_CDIW'] = false; }), /注药时 DIW 没在流/);
  // 快排时分流全关：快排的水也会被报出来
  const q = new OneBath();
  q.addLiquid(0.4, { H2SO4: 3 }, 25);
  q.startDump(true);
  const state = oneBathState('ob1', q, { open: {}, run: {}, tank: {} });
  state.open['ob1.V_DA'] = false;
  const { flows, blocked } = computeFlows(PIPING, state);
  assert.deepEqual(blocked, ['ob1.PAN']);
  assert.equal(flows['ob1.TANK>ob1.V_QDR'], undefined);
});

test('单槽回收的两条规则：干净的水快排也不进回收；冲干净以后还要再溢流一段时间才切回收', () => {
  const ob = new OneBath();                       // 新槽：满槽干净 DIW
  const dest = () => drainTo(computeFlows(PIPING, oneBathState('ob1', ob, { open: {}, run: {}, tank: {} })).flows, 'ob1');
  ob.supply(30, P.coldC);
  assert.deepEqual(dest(), ['sink.acid'], '刚开始溢流：先冲排液管');
  for (let t = 0; t < P.reclaimDelayS - 1; t += 0.5) ob.step(0.5);
  assert.deepEqual(dest(), ['sink.acid'], `还没到 ${P.reclaimDelayS} s`);
  for (let t = 0; t < 2; t += 0.5) ob.step(0.5);
  assert.deepEqual(dest(), ['sink.reclaim'], '溢流够久了，切回收');
  ob.startDump(true);
  assert.equal(ob.fluid(), 'DIW');
  assert.deepEqual(dest(), ['sink.acid'], '快排：哪怕是干净的水也不进回收');
  ob.step(0.5);
  assert.equal(ob.cleanS, 0, '快排以后计时从头算');
});

test('单槽：H₂O₂ 按注入流量选大 / 小流量阀；槽里液体的叫法按浓度和比电阻', () => {
  const ob = new OneBath();
  assert.equal(ob.fluid(), 'DIW');
  const open = () => oneBathState('ob1', ob, { open: {}, run: {}, tank: {} }).open;
  ob.supply(30, P.coldC, { species: 'H2O2', ratio: 10 });     // 注入 2.7 L/min
  assert.ok(open()['ob1.V_H2O2L'] && !open()['ob1.V_H2O2S']);
  ob.supply(30, P.coldC, { species: 'H2O2', ratio: 200 });    // 注入 0.15 L/min
  assert.ok(open()['ob1.V_H2O2S'] && !open()['ob1.V_H2O2L']);
  ob.supply(30, 70);
  assert.ok(open()['ob1.V_HOT'] && !open()['ob1.V_CDIW']);
  ob.stop();
  ob.addLiquid(0.4, { NH3: 2.2, H2O2: 1.4 }, 75);
  assert.equal(ob.fluid(), 'NH3');
  ob.c = { HF: 0, HCl: 0, H2SO4: 1e-5, NH3: 0, H2O2: 0 };
  ob.step(1);
  assert.equal(ob.fluid(), 'RA');
});
