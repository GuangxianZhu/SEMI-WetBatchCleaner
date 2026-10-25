// 管路：拓扑完整、流向和流程一致、联锁不被违反（docs/管路.md）
import test from 'node:test';
import assert from 'node:assert/strict';
import { Line, PIPING } from '../tool.js';
import { ChemBath, CB } from '../chembath.js';
import { P } from '../params.js';
import { DEFAULT } from '../recipe.js';

const flowing = (fl, a, b) => fl[`${a}>${b}`];
const CIRC = id => [[`${id}.OUT`, `${id}.PUMP`], [`${id}.PUMP`, `${id}.HTR`], [`${id}.HTR`, `${id}.FLT`], [`${id}.FLT`, `${id}.IN`]];

test('拓扑：管段端点都存在；每个阀、泵、加热器、过滤器都有进有出；没有孤立的元件', () => {
  for (const id in PIPING.nodes) {
    const n = PIPING.nodes[id], i = PIPING.inn[id].length, o = PIPING.out[id].length;
    if (['valve', 'pump', 'heater', 'filter'].includes(n.kind)) assert.ok(i > 0 && o > 0, id);
    if (id.startsWith('cb')) assert.ok(i + o > 0, `${id} 孤立`);
  }
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
