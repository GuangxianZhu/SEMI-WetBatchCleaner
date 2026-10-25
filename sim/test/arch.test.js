// 主控 / 子控的分工（docs/软件结构.md）：主控只发命令、看状态，不碰设备；每个命令都有回音；晶圆追踪和机台一致
import test from 'node:test';
import assert from 'node:assert/strict';
import { Line } from '../tool.js';
import { DEFAULT, cloneRecipe } from '../recipe.js';

const DEVICES = ['robot', 'lift', 'loader', 'batch', 'cb1', 'cb2', 'ob1', 'ob2', 'dr', 'surf', 'carry'];

// 主控拿到的"机台"换成一个代理：碰设备就报错
function guardMain(L) {
  L.main.L = new Proxy(L, {
    get(t, k) {
      if (DEVICES.includes(k)) throw new Error(`主控直接碰了设备 L.${String(k)}`);
      return t[k];
    },
  });
}

function runBatch(L, each = () => {}) {
  for (let i = 0; i < L.steps.length; i++) {
    L.startStep(i);
    while (L.busy) L.step(0.5);
    each(i);
  }
  while (L.subs.some(s => s.jobs.length)) L.step(0.5);
}

test('主控不碰设备：整批跑完，主控只通过命令和子控上报的状态做事', () => {
  const L = new Line(DEFAULT);
  guardMain(L);
  runBatch(L);
  assert.ok(L.done);
  assert.deepEqual(L.violations, []);
});

test('每个命令都有且只有一个"做完了"；每个槽收到一次单元配方，内容和配方一致', () => {
  const L = new Line(DEFAULT);
  const sent = [], done = [];
  const send = L.bus.send.bind(L.bus);
  L.bus.send = (from, to, type, body) => {
    const id = send(from, to, type, body);
    if (type === 'cmd') sent.push({ id, to, body });
    if (type === 'done') done.push(body.of);
    return id;
  };
  runBatch(L);
  assert.deepEqual(done.slice().sort((a, b) => a - b), sent.map(c => c.id).sort((a, b) => a - b));
  const units = sent.filter(c => c.body.cmd === 'RUN_UNIT');
  assert.deepEqual(units.map(c => c.to), DEFAULT.flow.units.map(id => DEFAULT.units[id].bath));
  for (const c of units) {
    const { id, ...u } = c.body.unit;
    assert.deepEqual(u, DEFAULT.units[id]);
  }
});

test('晶圆追踪：每个工艺步骤做完，主控记录的位置和机台上真实的位置一致', () => {
  const L = new Line(DEFAULT);
  runBatch(L, i => assert.equal(L.main.wafer, L.batch.holder, `第 ${i + 1} 步：${L.steps[i].name}`));
  assert.equal(L.main.wafer, 'foup');
});

test('消息是复制过去的：命令发出去以后再改配方，正在执行的单元不受影响', () => {
  const R = cloneRecipe(DEFAULT);
  const L = new Line(R);
  for (let i = 0; i < 4; i++) { L.startStep(i); while (L.busy) L.step(0.5); }
  L.startStep(4);                       // 单槽 1 的单元已经发给子控
  L.R.units.rinse1.steps.length = 0;    // 主控这边的配方被改掉
  while (L.busy) L.step(0.5);
  assert.equal(L.stepLog.filter(r => r.unit === 'rinse1').length, DEFAULT.units.rinse1.steps.length);
});

test('子控报警送到主控：去掉 N₂ 置换，干燥槽子控报"氧没降下来就供 IPA"，主控记下来', () => {
  const R = cloneRecipe(DEFAULT);
  R.units.dry.steps = R.units.dry.steps.filter(s => s.kind !== 'purge');
  const L = new Line(R);
  runBatch(L);
  const alarms = L.bus.log.filter(m => m.type === 'alarm');
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].from, 'dr');
  assert.match(L.violations[0].msg, /氧浓度没降下来就供 IPA/);
});
