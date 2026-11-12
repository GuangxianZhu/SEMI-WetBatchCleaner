// 细模型（build_wetbench.py → output/wetbench_detail.glb）：零件信息齐全、金属度不超标、文件不太大、剖切版和会动的部分都在。
// 只读 glb 里的 JSON 块，不依赖 three.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../output/wetbench_detail.glb', import.meta.url));
const have = existsSync(path);

function readGlb() {
  const buf = readFileSync(path);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, 'glb 文件头');
  const len = buf.readUInt32LE(12);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, '第一块是 JSON');
  return { size: buf.length, json: JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) };
}

test('细模型 glb：不超过 10 MB；四组都有；每个零件都有编号、中文名、材料、作用、爆炸方向', { skip: !have && '还没生成 glb' }, () => {
  const { size, json } = readGlb();
  assert.ok(size < 10e6, `${(size / 1e6).toFixed(1)} MB`);
  const nodes = json.nodes.filter(n => n.extras && n.extras.asm);
  const parts = nodes.filter(n => n.extras.part_no && n.extras.variant !== 'cut');
  for (const asm of ['cb', 'ob', 'dr', 'tr']) assert.ok(parts.filter(n => n.extras.asm === asm).length >= 15, `${asm} 的零件数`);
  const nos = new Set();
  for (const n of parts) {
    const e = n.extras;
    assert.ok(!nos.has(e.part_no), `编号重复 ${e.part_no}`);
    nos.add(e.part_no);
    assert.ok(e.name_cn && e.group, `${n.name} 没有中文名 / 子系统`);
    if (e.pid !== 'floor') assert.ok(e.desc && e.desc.length >= 10 && e.material_spec, `${n.name} 没写作用 / 材料`);
    assert.equal(e.ex.length, 3, `${n.name} 的爆炸方向`);
  }
});

test('细模型 glb：三种槽都有剖切版和液流箭头；会动的部分按 id__子名 命名，带位移', { skip: !have && '还没生成 glb' }, () => {
  const { json } = readGlb();
  const ex = json.nodes.filter(n => n.extras && n.extras.asm).map(n => ({ name: n.name, ...n.extras }));
  for (const asm of ['cb', 'ob', 'dr']) {
    const a = ex.filter(e => e.asm === asm);
    assert.ok(a.filter(e => e.variant === 'cut').length >= 8, `${asm} 的剖切版`);
    assert.ok(a.some(e => e.flow), `${asm} 的液流箭头`);
    // 每个"要换成剖切版"的零件都找得到它的剖切版
    for (const e of a.filter(e => e.cut === 'alt')) assert.ok(a.some(c => c.variant === 'cut' && c.pid === e.pid), `${asm}/${e.pid} 缺剖切版`);
    for (const key of ['inner', 'tank']) if (a.some(e => e.pid === key)) assert.equal(a.find(e => e.pid === key && !e.variant).cut, 'alt', '槽体被剖开');
  }
  assert.ok(ex.every(e => e.asm !== 'tr' || e.variant !== 'cut'), '搬送那一组不剖');
  const movers = ex.filter(e => e.mvg && !e.variant);
  assert.deepEqual([...new Set(movers.map(e => `${e.asm}.${e.mvg}`))].sort(), ['cb.lid', 'cb.lifter', 'dr.lid', 'dr.lifter', 'ob.lifter', 'tr.chuck', 'tr.door']);
  for (const e of movers) {
    assert.match(e.pid, /__/, `${e.pid}：会动的部分名字是 id__子名`);
    assert.ok(Math.hypot(...e.mv) > 0.01, `${e.pid} 的位移`);
  }
});

test('细模型 glb：金属度都不超过 0.55（以后导进 VR：那边没有反射探针）', { skip: !have && '还没生成 glb' }, () => {
  const { json } = readGlb();
  for (const m of json.materials) {
    const metal = (m.pbrMetallicRoughness || {}).metallicFactor ?? 1;
    assert.ok(metal <= 0.55 + 1e-6, `${m.name} 金属度 ${metal}`);
  }
});
