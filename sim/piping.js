// 管路：一份拓扑数据，同时给 2D 管路图、流向计算、3D 管子用（docs/管路.md）。
// 现在只有药液槽（cb1、cb2）的功能块级模板，当样板；单槽、减压干燥槽确认样板后再做。
//
// 节点 kind：source（供应）/ sink（排液、排风）/ tank / valve / pump / heater / filter
// 管段：a → b 是正常流动方向；sys 表示属于哪个系统（supply 供液 / circ 循环 / overflow 溢流 / drain 排液 / exhaust 排风）
// 流向只算"哪条管在流、流的是什么"，不算压力和流量。

// ---------- 公共设施 ----------
export const FACILITY = {
  'src.DIW': { kind: 'source', label: 'DIW', fluid: 'DIW' },
  'src.H2SO4': { kind: 'source', label: 'H₂SO₄', fluid: 'H2SO4' },
  'src.H2O2': { kind: 'source', label: 'H₂O₂', fluid: 'H2O2' },
  'src.NH3': { kind: 'source', label: 'NH₄OH', fluid: 'NH3' },
  'sink.acid': { kind: 'sink', label: '酸排液', accepts: 'acid' },
  'sink.alk': { kind: 'sink', label: '碱排液', accepts: 'alk' },
  'sink.exAcid': { kind: 'sink', label: '酸排风', accepts: 'gas' },
  'sink.exAlk': { kind: 'sink', label: '碱排风', accepts: 'gas' },
};

// 液体的酸碱性（排液分流和联锁用）
export const FLUID_CLASS = { SPM: 'acid', H2SO4: 'acid', HF: 'acid', HCl: 'acid', SC1: 'alk', NH3: 'alk', H2O2: 'neutral', DIW: 'neutral', gas: 'gas' };
export const FLUID_NAME = { SPM: 'SPM', SC1: 'SC1', H2SO4: 'H₂SO₄', H2O2: 'H₂O₂', NH3: 'NH₄OH', DIW: 'DIW', gas: '排气' };

// ---------- 高温药液槽模板 ----------
// at：2D 管路图坐标（viewBox 0 0 660 430）；r2：2D 折线；r3：3D 折线（x 相对槽中心，y、z 是绝对坐标）
// 3D 尺寸和 web/app.js 一致：内槽底 y = 0.60，槽口 y = 1.00，内槽 0.33 × 0.35 m
export function chemBathTemplate(id, kind) {
  const spm = kind === 'SPM';
  const c1 = spm ? 'H2SO4' : 'NH3', c2 = 'H2O2';
  const drain = spm ? 'sink.acid' : 'sink.alk', ex = spm ? 'sink.exAcid' : 'sink.exAlk';
  const C1 = FACILITY[`src.${c1}`].label, C2 = FACILITY[`src.${c2}`].label;
  const k = s => `${id}.${s}`;
  const nodes = {
    [k('IN')]: { kind: 'tank', label: '内槽', role: '晶圆泡在这里；药液从底部进、从顶部溢流到外槽' },
    [k('OUT')]: { kind: 'tank', label: '外槽', role: '接住内槽的溢流，给循环泵当缓冲' },
    [k('V_DIW')]: { kind: 'valve', label: 'DIW 供液阀', tag: 'V1', at: [138, 102], role: '建浴、稀释、补蒸发掉的水' },
    [k('V_C1')]: { kind: 'valve', label: `${C1} 供液阀`, tag: 'V2', at: [138, 62], role: '建浴、按浓度补液（阶段 3）' },
    [k('V_C2')]: { kind: 'valve', label: `${C2} 供液阀`, tag: 'V3', at: [138, 22], role: '建浴、按浓度补液（H₂O₂ 会分解，要补）' },
    [k('PUMP')]: { kind: 'pump', label: '循环泵', tag: 'P1', at: [200, 330], role: '一直在转：外槽 → 加热器 → 过滤器 → 内槽底部。放在最前面，吸入侧没有阻力件，热药液不容易汽蚀' },
    [k('HTR')]: { kind: 'heater', label: '加热器', tag: 'H1', at: [320, 390], role: '保温到设定值；没有液体流过时会空烧，所以泵停它必须停' },
    [k('FLT')]: { kind: 'filter', label: '过滤器', tag: 'F1', at: [440, 330], role: '拦住颗粒（也拦住泵和加热器掉出来的）；压差升高说明堵了（消耗件）' },
    [k('V_DR')]: { kind: 'valve', label: '内槽排液阀', tag: 'V4', at: [560, 258], role: '换液时排掉旧液' },
    [k('V_DRO')]: { kind: 'valve', label: '外槽排液阀', tag: 'V5', at: [560, 300], role: '换液时排掉外槽和循环线里的旧液' },
  };
  const fac = { [`src.DIW`]: [40, 102], [`src.${c1}`]: [40, 62], [`src.${c2}`]: [40, 22], [drain]: [630, 280], [ex]: [630, 120] };
  const e = (a, b, sys, r2, r3) => ({ id: `${a}>${b}`, a, b, sys, r2, r3 });
  const x = [0.05, 0.09, 0.13];   // 三个供液口（在内槽后沿上方，避开升降器立柱）
  const edges = [
    e('src.DIW', k('V_DIW'), 'supply', [[64, 102], [128, 102]], [[x[0], 1.10, -0.62], [x[0], 1.10, -0.36]]),
    e(k('V_DIW'), k('IN'), 'supply', [[148, 102], [250, 102], [250, 150]], [[x[0], 1.10, -0.32], [x[0], 1.10, -0.165], [x[0], 1.03, -0.165]]),
    e(`src.${c1}`, k('V_C1'), 'supply', [[64, 62], [128, 62]], [[x[1], 1.10, -0.62], [x[1], 1.10, -0.36]]),
    e(k('V_C1'), k('IN'), 'supply', [[148, 62], [290, 62], [290, 150]], [[x[1], 1.10, -0.32], [x[1], 1.10, -0.165], [x[1], 1.03, -0.165]]),
    e(`src.${c2}`, k('V_C2'), 'supply', [[64, 22], [128, 22]], [[x[2], 1.10, -0.62], [x[2], 1.10, -0.36]]),
    e(k('V_C2'), k('IN'), 'supply', [[148, 22], [330, 22], [330, 150]], [[x[2], 1.10, -0.32], [x[2], 1.10, -0.165], [x[2], 1.03, -0.165]]),
    e(k('IN'), k('OUT'), 'overflow', [[440, 140], [462, 140], [462, 160]], null),
    e(k('OUT'), k('PUMP'), 'circ', [[200, 285], [200, 312]], [[-0.21, 0.86, 0.205], [-0.21, 0.17, 0.205], [-0.13, 0.17, 0.205], [-0.13, 0.17, 0.17]]),
    e(k('PUMP'), k('HTR'), 'circ', [[200, 348], [200, 390], [292, 390]], [[-0.13, 0.17, 0.07], [-0.13, 0.17, -0.14], [-0.11, 0.17, -0.14]]),
    e(k('HTR'), k('FLT'), 'circ', [[348, 390], [440, 390], [440, 348]], [[0.11, 0.17, -0.14], [0.13, 0.17, -0.14], [0.13, 0.17, 0.12]]),
    // 回流口、内槽排液口在内槽底的角上（SC1 槽底中间是兆声振板）
    e(k('FLT'), k('IN'), 'circ', [[440, 312], [440, 296], [380, 296], [380, 265]], [[0.13, 0.47, 0.12], [0.13, 0.54, 0.12], [0.13, 0.54, 0.165], [0.155, 0.54, 0.165], [0.155, 0.594, 0.165]]),
    e(k('IN'), k('V_DR'), 'drain', [[440, 258], [550, 258]], [[0.155, 0.594, -0.16], [0.155, 0.40, -0.16]]),
    e(k('V_DR'), drain, 'drain', [[570, 258], [600, 258], [600, 280], [612, 280]], [[0.155, 0.34, -0.16], [0.155, 0.10, -0.16], [0.155, 0.10, -0.32]]),
    e(k('OUT'), k('V_DRO'), 'drain', [[470, 285], [470, 300], [550, 300]], [[0.21, 0.86, -0.205], [0.21, 0.52, -0.205]]),
    e(k('V_DRO'), drain, 'drain', [[570, 300], [600, 300], [600, 280], [612, 280]], [[0.21, 0.46, -0.205], [0.21, 0.10, -0.205], [0.21, 0.10, -0.32]]),
    e(k('IN'), ex, 'exhaust', [[420, 150], [420, 120], [612, 120]], null),
  ];
  // 仪表（不参与流动）：温度、外槽液位、过滤器压差
  const inst = [
    { id: k('TT'), tag: 'TT', label: '温度', at: [380, 410], on: k('HTR') },
    { id: k('LT'), tag: 'LT', label: '外槽液位', at: [500, 200], on: k('OUT') },
    { id: k('PDT'), tag: 'PDT', label: '过滤器压差', at: [505, 352], on: k('FLT') },
  ];
  // 3D 里泵、加热器、过滤器、阀门的位置（x 相对槽中心）
  const p3 = {
    [k('PUMP')]: [-0.13, 0.17, 0.12], [k('HTR')]: [0, 0.17, -0.14], [k('FLT')]: [0.13, 0.32, 0.12],
    [k('V_DIW')]: [x[0], 1.10, -0.34], [k('V_C1')]: [x[1], 1.10, -0.34], [k('V_C2')]: [x[2], 1.10, -0.34],
    [k('V_DR')]: [0.155, 0.37, -0.16], [k('V_DRO')]: [0.21, 0.49, -0.205],
  };
  // 2D：内槽、外槽的框（照作者的概要图：内槽在外槽里面，供液从上方进内槽）
  const box2 = { out: [200, 140, 280, 145], in: [230, 150, 210, 115] };
  return { id, kind, nodes, edges, inst, fac, p3, box2, chem: [c1, c2] };
}

// ---------- 把模板拼成一张图 ----------
export function buildGraph(templates) {
  const nodes = { ...FACILITY };
  const edges = [];
  for (const t of templates) { Object.assign(nodes, t.nodes); edges.push(...t.edges); }
  const out = {}, inn = {};
  for (const id in nodes) { out[id] = []; inn[id] = []; }
  for (const e of edges) {
    if (!nodes[e.a] || !nodes[e.b]) throw new Error(`管段 ${e.id} 的端点不存在`);
    out[e.a].push(e); inn[e.b].push(e);
  }
  return { nodes, edges, out, inn, templates };
}

// ---------- 流向 ----------
// state：
//   open[valveId]、run[pumpId]：阀门、泵的状态
//   tank[tankId] = { fluid, full }：槽里有什么液体（null 表示空）、满没满
// 规则（docs/管路.md 1.2）：
//   - 供应源有压力：从源头经开着的阀到达槽或出口的路径在流
//   - 槽里有液体：经运行的泵到达另一个槽（泵送），或经开着的排液阀到达排液出口（重力）的路径在流
//   - 溢流：槽满了而且有液体流进来，溢流管在流
//   - 排风：槽里有液体，排风管一直在流
export function computeFlows(G, state) {
  const flows = {};   // edgeId → fluid
  const passThrough = id => {
    const n = G.nodes[id];
    if (n.kind === 'valve') return !!state.open[id];
    if (n.kind === 'pump') return !!state.run[id];
    return n.kind === 'heater' || n.kind === 'filter';
  };
  const isAcceptor = id => G.nodes[id].kind === 'tank' || G.nodes[id].kind === 'sink';
  // 从 start 出发找到达接收者的路径；mode：'push'（供应压力）/ 'pump'（必须经过运行的泵）/ 'gravity'（只走排液、到出口）
  function walk(start, fluid, mode) {
    const stack = [[start, [], false]];
    while (stack.length) {
      const [id, path, viaPump] = stack.pop();
      for (const e of G.out[id]) {
        if (e.sys === 'overflow' || e.sys === 'exhaust') continue;
        if (mode === 'gravity' && e.sys !== 'drain') continue;
        if (path.includes(e)) continue;
        const b = e.b, np = [...path, e];
        if (isAcceptor(b)) {
          const ok = mode === 'push' || (mode === 'pump' && viaPump) || (mode === 'gravity' && G.nodes[b].kind === 'sink');
          if (ok) for (const pe of np) flows[pe.id] = fluid;
          continue;
        }
        if (!passThrough(b)) continue;
        stack.push([b, np, viaPump || G.nodes[b].kind === 'pump']);
      }
    }
  }
  for (const id in G.nodes) {
    const n = G.nodes[id];
    if (n.kind === 'source') walk(id, n.fluid, 'push');
    if (n.kind === 'tank') {
      const t = state.tank[id];
      if (t && t.fluid) { walk(id, t.fluid, 'pump'); walk(id, t.fluid, 'gravity'); }
    }
  }
  // 溢流：槽满了、而且有液体流进来
  for (const e of G.edges) {
    if (e.sys === 'overflow') {
      const t = state.tank[e.a];
      if (t && t.fluid && t.full && G.inn[e.a].some(x => flows[x.id])) flows[e.id] = t.fluid;
    }
    if (e.sys === 'exhaust') { const t = state.tank[e.a]; if (t && t.fluid) flows[e.id] = 'gas'; }
  }
  return flows;
}

// ---------- 从药液槽的状态推出阀门、泵、槽的状态 ----------
export function chemBathState(id, cb, state = { open: {}, run: {}, tank: {} }) {
  for (const v in cb.valve) state.open[`${id}.${v}`] = cb.valve[v];
  state.run[`${id}.PUMP`] = cb.pump;
  const fluid = cb.fluid();
  state.tank[`${id}.IN`] = { fluid, full: cb.innerFull };
  state.tank[`${id}.OUT`] = { fluid: cb.outerLevel > 0.001 ? fluid : null, full: false };
  state.heater = state.heater || {};
  state.heater[`${id}.HTR`] = cb.heater;
  return state;
}

// 联锁检查（用管路状态）：返回违反的条目
export function checkInterlocks(G, state, flows) {
  const bad = [];
  for (const id in G.nodes) {
    const n = G.nodes[id];
    if (n.kind === 'heater' && state.heater && state.heater[id]) {
      const flowing = G.inn[id].some(e => flows[e.id]);
      if (!flowing) bad.push(`${id}：加热器开着但没有液体流过（会空烧）`);
    }
  }
  for (const e of G.edges) {
    const f = flows[e.id];
    if (!f) continue;
    const sink = G.nodes[e.b];
    if (sink.kind === 'sink' && sink.accepts !== 'gas' && FLUID_CLASS[f] !== 'neutral' && FLUID_CLASS[f] !== sink.accepts) bad.push(`${e.id}：${FLUID_NAME[f]} 流进了${sink.label}`);
  }
  return bad;
}
