// 管路：一份拓扑数据，同时给 2D 管路图、流向计算、3D 管子用（docs/管路.md）。
// 现在有药液槽（cb1、cb2）和单槽（ob1、ob2）的功能块级模板；减压干燥槽、夹爪清洗干燥位以后再做。
//
// 节点 kind：source（供应）/ sink（排液、排风）/ tank（槽，有自己的液位）/ basin（接液槽：进多少出多少，没有液位）/
//   valve / pump / heater / filter / mixer（混合块）/ unit（流量控制这类串在管上的单元）/ junction（汇合、分流点）/ nozzle / device（不过液体的设备，如兆声振板）
// 管段：a → b 是正常流动方向；sys 表示属于哪个系统（supply 供液 / spray 喷在液面上、不让槽溢流 / circ 循环 / overflow 溢流 /
//   drain 排液 / exhaust 排风 / vac 抽真空 / vent 气体从密封腔顶出去）
// 流向只算"哪条管在流、流的是什么"，不算压力和流量。

import { P } from './params.js';

// ---------- 公共设施 ----------
export const FACILITY = {
  'src.DIW': { kind: 'source', label: 'DIW', fluid: 'DIW' },
  'src.H2SO4': { kind: 'source', label: 'H₂SO₄', fluid: 'H2SO4' },
  'src.H2O2': { kind: 'source', label: 'H₂O₂', fluid: 'H2O2' },
  'src.NH3': { kind: 'source', label: 'NH₄OH', fluid: 'NH3' },
  'src.HF': { kind: 'source', label: 'HF', fluid: 'HF' },
  'src.HCl': { kind: 'source', label: 'HCl', fluid: 'HCl' },
  'src.HDIW': { kind: 'source', label: '热 DIW', fluid: 'HDIW' },
  'sink.acid': { kind: 'sink', label: '酸排液', accepts: 'acid' },
  'sink.alk': { kind: 'sink', label: '碱排液', accepts: 'alk' },
  'sink.reclaim': { kind: 'sink', label: 'DIW 回收', accepts: 'clean' },
  'sink.exAcid': { kind: 'sink', label: '酸排风', accepts: 'gas' },
  'sink.exAlk': { kind: 'sink', label: '碱排风', accepts: 'gas' },
  'src.N2': { kind: 'source', label: 'N₂', fluid: 'N2' },
  'src.IPA': { kind: 'source', label: 'IPA', fluid: 'IPA' },
  'sink.exOrg': { kind: 'sink', label: '有机排风', accepts: 'gas' },
};

// 液体的酸碱性（排液分流和联锁用）。RA / RK：单槽里还没冲干净的冲洗水（酸性 / 碱性），见 OneBath.fluid()
export const FLUID_CLASS = {
  SPM: 'acid', H2SO4: 'acid', HF: 'acid', HCl: 'acid', RA: 'acid', SC1: 'alk', NH3: 'alk', RK: 'alk',
  H2O2: 'neutral', DIW: 'neutral', HDIW: 'neutral', gas: 'gas',
  IPA: 'organic', N2: 'gas', IPAV: 'gas', air: 'gas',
};
export const FLUID_NAME = {
  SPM: 'SPM', SC1: 'SC1', H2SO4: 'H₂SO₄', H2O2: 'H₂O₂', NH3: 'NH₄OH', HF: 'HF', HCl: 'HCl',
  DIW: 'DIW', HDIW: '热 DIW', RA: '酸性冲洗水', RK: '碱性冲洗水', gas: '排气',
  IPA: 'IPA', N2: 'N₂', IPAV: 'N₂ + IPA 蒸气', air: '空气',
};
// 一段管同时被几股液体走到时（例如混合块下游），显示"最浓"的那股：药液 > 热 DIW > DIW
const FLUID_RANK = f => (f === 'DIW' || f === 'gas' ? 0 : f === 'HDIW' ? 1 : 2);
// 管段工厂：同一对端点有两条管（例如两侧溢流）时用 sfx 区分
const edge = (a, b, sys, r2, r3, sfx) => ({ id: `${a}>${b}${sfx ? '#' + sfx : ''}`, a, b, sys, r2, r3 });

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
  const e = edge;
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
  const box2 = { out: [200, 140, 280, 145], in: [230, 150, 210, 115], outId: k('OUT'), inId: k('IN'), outLabel: '外槽', inLabel: '内槽（晶圆）', outLabelAt: [475, 279, 'end'] };
  // 3D：排液总管（y、z、长度）
  const hdr3 = [[0.10, -0.32, 0.56]];
  const legend = [kind, c1, c2, 'DIW'];
  return { id, type: 'chembath', kind, nodes, edges, inst, fac, p3, box2, hdr3, legend, chem: [c1, c2] };
}

// ---------- 单槽模板 ----------
// 照作者的概要图（2026-10-25，两张，都是作者凭记忆画的；热水按第二张）：
//   冷 DIW、热 DIW 各一个阀 → 汇合 → 流量控制 → 混合块（HF、HCl、NH₄OH、H₂O₂ 大 / 小流量注进来）→ 槽底进液
//   两侧溢流、侧面的快排都落进接液槽 → 一根排液管 → 分流到酸排液 / 碱排液 / DIW 回收
//   淋浴：DIW → 槽上方的喷嘴；兆声振板在槽底、进液口旁边；比电阻计在槽里
export const OB = {
  h2o2SmallMaxLpm: 0.5,   // H₂O₂ 注入流量小于这个走小流量阀（估计；两个流量范围是作者确认的，分界是原创）
};
const OB_INJECT = { V_HF: 'HF', V_HCl: 'HCl', V_NH3: 'NH3', V_H2O2L: 'H2O2', V_H2O2S: 'H2O2' };
const OB_DRAIN = ['V_DA', 'V_DK', 'V_DREC'];

export function oneBathTemplate(id) {
  const k = s => `${id}.${s}`;
  const V = (tag, label, at, role, more = {}) => ({ kind: 'valve', tag, label, at, role, ...more });
  const nodes = {
    [k('TANK')]: { kind: 'tank', label: '槽', role: '石英槽，晶圆泡在这里。底部进液、两侧顶部溢流；快排口在槽底侧面。比电阻计、温度计装在槽里' },
    [k('PAN')]: { kind: 'basin', label: '接液槽', role: '把槽围起来的外槽：两侧的溢流和快排的水都落到这里，再从一根排液管出去。进多少出多少，自己不存液' },
    [k('V_CDIW')]: V('V1', '冷 DIW 阀', [110, 418], '主路：上流冲洗、快排后补水；药液注进这股水里'),
    [k('V_HOT')]: V('V2', '热 DIW 阀', [95, 384], '热水冲洗（SPM 之后先用热水冲：硫酸黏、难冲）。和冷水在流量控制前面汇合，所以热药液也是同一条路'),
    [k('V_HF')]: V('V3', 'HF 注入阀', [120, 272], '按比例把 HF 原液注进 DIW 流（满槽边进边溢，浓度慢慢爬升）'),
    [k('V_HCl')]: V('V4', 'HCl 注入阀', [172, 294], '按比例注入 HCl（这一版的配方不用）'),
    [k('V_NH3')]: V('V5', 'NH₄OH 注入阀', [120, 316], '按比例注入 NH₄OH（这一版的配方不用）'),
    [k('V_H2O2L')]: V('V6', 'H₂O₂ 注入阀（大流量）', [172, 338], '两个流量范围（作者确认）：配比浓、注入流量大时走这路'),
    [k('V_H2O2S')]: V('V7', 'H₂O₂ 注入阀（小流量）', [120, 360], '配比稀、注入流量小时走这路：一个阀覆盖不了这么宽的流量范围'),
    [k('MIX')]: { kind: 'mixer', label: '混合块', at: [230, 316], rect: [220, 262, 20, 108], role: '原液按比例注进冷 DIW 流，混合以后往上走。槽里的浓度 = 原液流量 ÷ 总流量（冷 + 热）' },
    [k('JN')]: { kind: 'junction', label: '汇合点', at: [170, 400], role: '冷 DIW、热 DIW 在这里汇合，再一起过流量控制' },
    [k('FCV')]: { kind: 'unit', label: '流量控制', short: '流量控制', at: [230, 400], part3: 'fcv', role: '流量计 + 流量调节：把进槽的总流量（冷 + 热）控制在设定值。注药的配比就是按这个总流量算的' },
    [k('V_SH')]: V('V8', '淋浴阀', [200, 20], '快排时开：液面降下去时晶圆一直被喷湿；快排后补水时一直喷到晶圆重新浸没'),
    [k('NOZ')]: { kind: 'nozzle', label: '淋浴喷嘴', at: [395, 36], role: '槽口两侧往晶圆上喷 DIW，防止液面降下去时弯月面把图形拉倒' },
    [k('V_QDR')]: V('V9', '快排阀', [420, 194], '大口径，几秒内把槽排空（快排冲洗 QDR），排进接液槽', { rot: true, big: true }),
    [k('JD')]: { kind: 'junction', label: '排液分流点', at: [490, 290], role: '一根排液管分成三路，同时只能开一路' },
    [k('V_DA')]: V('V10', '酸排液阀', [570, 240], '槽里有酸、冲洗水还没冲干净、或者正在注酸时走这路'),
    [k('V_DK')]: V('V11', '碱排液阀', [570, 290], '槽里有碱（例如 SC1 之后带进来的氨水）、或者正在注碱时走这路'),
    [k('V_DREC')]: V('V12', '回收阀', [570, 340], '只收干净的 DIW：比电阻够高以后还要再溢流一会儿才切过来；快排的水不进回收。酸碱进了回收会污染整个回收系统'),
    [k('MEGA')]: { kind: 'device', label: '兆声振板', rect: [366, 174, 46, 6], role: '槽底、进液口旁边（作者确认）。约 1 MHz，帮忙把小颗粒冲走；这一版的配方在单槽里不开' },
  };
  const fac = {
    'src.DIW': [[40, 20], [40, 418]], 'src.HDIW': [40, 384], 'src.HF': [40, 272], 'src.HCl': [40, 294], 'src.NH3': [40, 316], 'src.H2O2': [40, 349],
    'sink.acid': [630, 240], 'sink.alk': [630, 290], 'sink.reclaim': [630, 340],
  };
  const e = edge;
  // 注入阀：3D 里从后墙进来，排成一排插进混合块后面；阀交错放（z −0.36 / −0.44），不挤在一起
  const inj = [['V_HF', 'src.HF', -0.235, -0.36], ['V_HCl', 'src.HCl', -0.195, -0.44], ['V_NH3', 'src.NH3', -0.155, -0.36], ['V_H2O2L', 'src.H2O2', -0.115, -0.44], ['V_H2O2S', 'src.H2O2', -0.075, -0.36]];
  const inj2 = {   // 2D：[源 → 阀, 阀 → 混合块]
    V_HF: [[[64, 272], [110, 272]], [[130, 272], [220, 272]]],
    V_HCl: [[[64, 294], [162, 294]], [[182, 294], [220, 294]]],
    V_NH3: [[[64, 316], [110, 316]], [[130, 316], [220, 316]]],
    V_H2O2L: [[[64, 345], [84, 345], [84, 338], [162, 338]], [[182, 338], [220, 338]]],
    V_H2O2S: [[[64, 353], [84, 353], [84, 360], [110, 360]], [[130, 360], [220, 360]]],
  };
  const edges = [
    // 主路：冷 / 热 DIW → 汇合 → 流量控制 → 混合块，从下往上
    e('src.DIW', k('V_CDIW'), 'supply', [[64, 418], [100, 418]], [[-0.29, 0.15, -0.62], [-0.29, 0.15, -0.38]]),
    e(k('V_CDIW'), k('JN'), 'supply', [[120, 418], [170, 418], [170, 404]], [[-0.29, 0.15, -0.34], [-0.29, 0.15, -0.177]]),
    e('src.HDIW', k('V_HOT'), 'supply', [[64, 384], [85, 384]], [[-0.33, 0.15, -0.62], [-0.33, 0.15, -0.46]]),
    e(k('V_HOT'), k('JN'), 'supply', [[105, 384], [170, 384], [170, 396]], [[-0.33, 0.15, -0.42], [-0.33, 0.15, -0.16], [-0.307, 0.15, -0.16]]),
    e(k('JN'), k('FCV'), 'supply', [[174, 400], [206, 400]], [[-0.29, 0.167, -0.16], [-0.29, 0.18, -0.16]]),
    e(k('FCV'), k('MIX'), 'supply', [[230, 388], [230, 371]], [[-0.29, 0.26, -0.16], [-0.29, 0.31, -0.16], [-0.265, 0.31, -0.16]]),
    ...inj.flatMap(([v, src, x3, z3]) => [
      e(src, k(v), 'supply', inj2[v][0], [[x3, 0.31, -0.62], [x3, 0.31, z3 - 0.02]]),
      e(k(v), k('MIX'), 'supply', inj2[v][1], [[x3, 0.31, z3 + 0.02], [x3, 0.31, -0.185]]),
    ]),
    // 槽底进液（穿过接液槽底）
    e(k('MIX'), k('TANK'), 'supply', [[230, 262], [230, 248], [352, 248], [352, 174]], [[-0.045, 0.31, -0.16], [-0.02, 0.31, -0.16], [-0.02, 0.597, -0.16]]),
    // 淋浴
    e('src.DIW', k('V_SH'), 'supply', [[64, 20], [190, 20]], [[-0.10, 1.10, -0.62], [-0.10, 1.10, -0.38]]),
    e(k('V_SH'), k('NOZ'), 'supply', [[210, 20], [395, 20], [395, 28]], [[-0.10, 1.10, -0.34], [-0.10, 1.10, -0.205], [-0.10, 1.07, -0.205]]),
    e(k('NOZ'), k('TANK'), 'supply', [[395, 44], [395, 54]], null),
    // 两侧溢流、快排 → 接液槽
    e(k('TANK'), k('PAN'), 'overflow', [[342, 56], [320, 56], [320, 222]], null, 'L'),
    e(k('TANK'), k('PAN'), 'overflow', [[448, 56], [475, 56], [475, 222]], null, 'R'),
    e(k('TANK'), k('V_QDR'), 'drain', [[420, 172], [420, 183]], [[0.171, 0.63, 0], [0.205, 0.63, 0], [0.205, 0.605, 0]]),
    e(k('V_QDR'), k('PAN'), 'drain', [[420, 205], [420, 222]], [[0.205, 0.545, 0], [0.205, 0.505, 0]]),
    // 接液槽 → 一根排液管 → 分流
    e(k('PAN'), k('JD'), 'drain', [[490, 230], [490, 286]], [[0.20, 0.497, 0.12], [0.20, 0.365, 0.12]]),
    e(k('JD'), k('V_DA'), 'drain', [[494, 290], [530, 290], [530, 240], [560, 240]], [[0.185, 0.35, 0.12], [0.15, 0.35, 0.12], [0.15, 0.27, 0.12]]),
    e(k('JD'), k('V_DK'), 'drain', [[494, 290], [560, 290]], [[0.20, 0.335, 0.12], [0.20, 0.27, 0.12]]),
    e(k('JD'), k('V_DREC'), 'drain', [[494, 290], [530, 290], [530, 340], [560, 340]], [[0.215, 0.35, 0.12], [0.25, 0.35, 0.12], [0.25, 0.27, 0.12]]),
    e(k('V_DA'), 'sink.acid', 'drain', [[580, 240], [604, 240]], [[0.15, 0.23, 0.12], [0.15, 0.10, 0.12], [0.15, 0.10, -0.46]]),
    e(k('V_DK'), 'sink.alk', 'drain', [[580, 290], [604, 290]], [[0.20, 0.23, 0.12], [0.20, 0.14, 0.12], [0.20, 0.14, -0.50]]),
    e(k('V_DREC'), 'sink.reclaim', 'drain', [[580, 340], [604, 340]], [[0.25, 0.23, 0.12], [0.25, 0.18, 0.12], [0.25, 0.18, -0.54]]),
  ];
  // 仪表（不参与流动）：比电阻、温度在槽里（作者确认），供液流量在流量控制上
  const inst = [
    { id: k('AT'), tag: 'AT', label: '比电阻', at: [580, 100], to: [446, 100], on: k('TANK') },
    { id: k('TT'), tag: 'TT', label: '温度', at: [580, 150], to: [446, 150], on: k('TANK') },
    { id: k('FT'), tag: 'FT', label: '供液流量', at: [290, 400], to: [254, 400], on: k('FCV') },
  ];
  // 3D 位置（x 相对槽中心）；size3：方块的尺寸；act3：阀门执行器朝哪边（默认朝上）
  const p3 = {
    [k('V_CDIW')]: [-0.29, 0.15, -0.36], [k('V_HOT')]: [-0.33, 0.15, -0.44], [k('JN')]: [-0.29, 0.15, -0.16],
    [k('FCV')]: [-0.29, 0.22, -0.16], [k('MIX')]: [-0.155, 0.31, -0.16],
    [k('V_SH')]: [-0.10, 1.10, -0.36], [k('V_QDR')]: [0.205, 0.575, 0],
    [k('JD')]: [0.20, 0.35, 0.12], [k('V_DA')]: [0.15, 0.25, 0.12], [k('V_DK')]: [0.20, 0.25, 0.12], [k('V_DREC')]: [0.25, 0.25, 0.12],
    [k('MEGA')]: [0, 0.5725, 0],
    ...Object.fromEntries(inj.map(([v, , x3, z3]) => [k(v), [x3, 0.31, z3]])),
  };
  const size3 = { [k('MIX')]: [0.22, 0.05, 0.05], [k('FCV')]: [0.06, 0.08, 0.06], [k('MEGA')]: [0.26, 0.025, 0.24] };
  const act3 = { [k('V_QDR')]: 'z', [k('V_DA')]: 'z', [k('V_DK')]: 'z', [k('V_DREC')]: 'z' };
  const box2 = { out: [300, 72, 200, 158], in: [340, 52, 110, 120], outId: k('PAN'), inId: k('TANK'), outLabel: '接液槽', inLabel: '槽（晶圆）', outLabelAt: [304, 86, 'start'] };
  const hdr3 = [[0.10, -0.46, 0.5], [0.14, -0.50, 0.5], [0.18, -0.54, 0.5]];
  const legend = ['DIW', 'HDIW', 'HF', 'RA', 'RK', 'H2SO4', 'NH3'];
  // 联锁要用的：哪个阀注什么药；哪些阀是载液（DIW）
  const rules = { inject: Object.fromEntries(Object.entries(OB_INJECT).map(([v, s]) => [k(v), s])), carrier: [k('V_CDIW'), k('V_HOT')] };
  return { id, type: 'onebath', nodes, edges, inst, fac, p3, size3, act3, box2, hdr3, legend, rules };
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
//   - 溢流：槽满了而且有液体流进来，溢流管在流；溢流进接液槽（basin）的，再从接液槽靠重力往下走
//   - 排风：槽里有液体，排风管一直在流
// 返回 flows（edgeId → 液体）和 blocked（有液体进来、但出口全关的接液槽：会满出来）
const PASS = new Set(['heater', 'filter', 'mixer', 'unit', 'junction', 'nozzle', 'basin']);
export function computeFlows(G, state) {
  const flows = {}, blocked = new Set();
  const mark = (eid, f) => { if (!flows[eid] || FLUID_RANK(f) > FLUID_RANK(flows[eid])) flows[eid] = f; };
  const passThrough = id => {
    const n = G.nodes[id];
    if (n.kind === 'valve') return !!state.open[id];
    if (n.kind === 'pump') return !!state.run[id];
    return PASS.has(n.kind);
  };
  const isAcceptor = id => G.nodes[id].kind === 'tank' || G.nodes[id].kind === 'sink';
  // 从 id 往下游走，找到达接收者的路径；mode：'push'（供应压力）/ 'pump'（必须经过运行的泵）/ 'gravity'（只走排液、到出口）
  // path 里记着每段管和流在里面的液体；返回有没有走到接收者
  function walk(id, fluid, mode, path, viaPump) {
    let any = false;
    for (const e of G.out[id]) {
      if (e.sys === 'overflow' || e.sys === 'exhaust') continue;
      if (mode === 'gravity' && e.sys !== 'drain' && e.sys !== 'vent') continue;   // 重力排液；气体从密封腔顶出去也走这条
      if (path.some(p => p[0] === e)) continue;
      const b = e.b, np = [...path, [e, fluid]];
      if (isAcceptor(b)) {
        const ok = mode === 'push' || (mode === 'pump' && viaPump) || (mode === 'gravity' && G.nodes[b].kind === 'sink');
        if (ok) { for (const [pe, f] of np) mark(pe.id, f); any = true; }
        continue;
      }
      if (!passThrough(b)) continue;
      if (walk(b, fluid, mode, np, viaPump || G.nodes[b].kind === 'pump')) any = true;
    }
    if (!any && mode === 'gravity' && G.nodes[id].kind === 'basin') blocked.add(id);
    return any;
  }
  for (const id in G.nodes) {
    const n = G.nodes[id];
    if (n.kind === 'source') walk(id, n.fluid, 'push', [], false);
    if (n.kind === 'tank') {
      const t = state.tank[id];
      if (t && t.fluid) { walk(id, t.fluid, 'pump', [], false); walk(id, t.fluid, 'gravity', [], false); }
    }
  }
  for (const e of G.edges) {
    // 溢流：槽满了、而且有液体流进来
    if (e.sys === 'overflow') {
      const t = state.tank[e.a];
      if (t && t.fluid && t.full && G.inn[e.a].some(x => flows[x.id] && x.sys !== 'spray')) {
        flows[e.id] = t.fluid;
        if (G.nodes[e.b].kind === 'basin') walk(e.b, t.fluid, 'gravity', [], false);
      }
    }
    if (e.sys === 'exhaust') { const t = state.tank[e.a]; if (t && t.fluid) flows[e.id] = 'gas'; }
  }
  return { flows, blocked: [...blocked] };
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

// ---------- 减压干燥槽模板 ----------
// 按功能设计（作者不熟悉干燥槽，按公开资料和作者确认的"水 + IPA 层 + 气体层、提拉、N₂ 吹干、减压"来定，docs/管路.md 第 5 节）：
//   槽里的水：冷 DIW → 混合块（HF、HCl 注进来）→ 槽底进液；两侧溢流、排水阀落进接液槽 → 分流到酸排液 / DIW 回收
//            （HF 放到干燥槽里做：HF 之后冲干净，不出液面直接干燥。同一个槽里做药液、冲洗、干燥的公开例子 [US6328809]）
//   IPA：IPA → IPA 阀 → 液面喷嘴（水面上形成一层 IPA，作者确认）
//   气体：N₂ → N₂ 阀 → 上部喷嘴（置换氧、吹干）；N₂ → 破真空阀（减压后回到大气压）
//         密封腔 → 真空阀 → 冷阱（把 IPA 蒸气凝下来）→ 真空泵 → 有机排风；密封腔 → 排气阀 → 有机排风（常压时）
export function dryerTemplate(id) {
  const k = s => `${id}.${s}`;
  const V = (tag, label, at, role, more = {}) => ({ kind: 'valve', tag, label, at, role, ...more });
  const nodes = {
    [k('TANK')]: { kind: 'tank', label: '槽（水）', role: '下面是一槽干净的 DIW，晶圆浸在里面；水面上供 IPA 形成一层 IPA，上面是密封的气体空间。也能上流冲洗、注 HF' },
    [k('CH')]: { kind: 'tank', label: '密封腔', role: '槽上面的气体空间，盖上盖子就密封：先用 N₂ 把氧赶走（IPA 可燃），再减压，最后用 N₂ 回到大气压' },
    [k('PAN')]: { kind: 'basin', label: '接液槽', role: '槽两侧的溢流和排水落到这里，再从一根排液管出去，分到酸排液 / DIW 回收' },
    [k('V_CDIW')]: V('V1', 'DIW 阀', [175, 418], '往槽里供 DIW：上流冲洗、注药时的载液'),
    [k('V_HF')]: V('V2', 'HF 注入阀', [130, 364], 'HF 放到干燥槽里做（HF-last）：HF 之后冲干净，不出液面直接干燥，疏水面不碰空气'),
    [k('V_HCl')]: V('V3', 'HCl 注入阀', [130, 390], '稀 HCl：和 HF 一起或者单独用，去金属（公开专利里和 HF 一起注进 DIW 流）'),
    [k('MIX')]: { kind: 'mixer', label: '混合块', at: [230, 377], rect: [220, 352, 20, 50], role: '原液按比例注进 DIW 流，从槽底进槽' },
    [k('V_QDR')]: V('V4', '排水阀', [430, 281], '槽底的大口径阀：把槽里的水排空（换水、HF 之后排掉）', { rot: true, big: true }),
    [k('JD')]: { kind: 'junction', label: '排液分流点', at: [490, 356], role: '一根排液管分成两路，同时只能开一路' },
    [k('V_DA')]: V('V5', '酸排液阀', [570, 334], '槽里有 HF、HCl，或者冲洗水还没冲干净时走这路'),
    [k('V_DREC')]: V('V6', '回收阀', [570, 384], '冲干净的 DIW 才能回收（和单槽同样的规则）'),
    [k('V_N2')]: V('V7', 'N₂ 阀', [150, 60], '置换：把氧赶下去再供 IPA（配方目标 1 %，联锁线 2 %）；之后一直小流量供着（抽真空时也供一点，帮着带走 IPA 蒸气，估计），最后用 N₂ 吹干'),
    [k('NOZ_N2')]: { kind: 'nozzle', label: 'N₂ 喷嘴', at: [392, 76], role: '密封腔上部的喷嘴，往下吹 N₂' },
    [k('V_VENT')]: V('V8', '破真空阀', [150, 100], '减压以后通 N₂ 回到大气压，盖子才能打开'),
    [k('V_IPA')]: V('V9', 'IPA 阀', [150, 128], '在水面上形成一层 IPA；IPA 可燃，盖子没关、氧没降下来不能开（联锁）'),
    [k('NOZ_IPA')]: { kind: 'nozzle', label: 'IPA 喷嘴', at: [366, 140], role: '贴着水面的喷嘴，IPA 落在水面上形成一层（作者确认：水面上是一层 IPA）' },
    [k('V_VAC')]: V('V10', '真空阀', [545, 60], '减压：压力越低沸点越低，残留液体在低温下很快蒸发；盖子没关不能开（联锁）'),
    [k('TRAP')]: { kind: 'unit', label: '冷阱', short: '冷阱', at: [600, 60], part3: 'vac', role: '把抽出来的 IPA 蒸气冷凝下来，不让它进真空泵' },
    [k('VP')]: { kind: 'pump', label: '真空泵', short: '真空泵', at: [600, 118], model: 'vac', labelSide: 'right', role: '把密封腔抽到减压；抽出来的气体走有机排风' },
    [k('V_EXH')]: V('V11', '排气阀', [545, 110], '关着盖、常压时一直开：注药时的雾气、供进来的 N₂ / IPA 蒸气从这里走有机排风；抽真空和破真空时关'),
    [k('LID')]: { kind: 'device', label: '密封盖', rect: [286, 26, 228, 8], role: '关上才能减压、供 IPA；开盖前要先回到大气压' },
  };
  const fac = {
    'src.DIW': [40, 418], 'src.HF': [40, 364], 'src.HCl': [40, 390], 'src.N2': [[40, 60], [40, 100]], 'src.IPA': [40, 128],
    'sink.acid': [630, 334], 'sink.reclaim': [630, 384], 'sink.exOrg': [600, 180],
  };
  const e = edge;
  const edges = [
    // 槽里的水
    e('src.DIW', k('V_CDIW'), 'supply', [[64, 418], [165, 418]], [[-0.29, 0.15, -0.62], [-0.29, 0.15, -0.38]]),
    e(k('V_CDIW'), k('MIX'), 'supply', [[185, 418], [230, 418], [230, 403]], [[-0.29, 0.15, -0.34], [-0.29, 0.15, -0.16], [-0.29, 0.31, -0.16], [-0.265, 0.31, -0.16]]),
    e('src.HF', k('V_HF'), 'supply', [[64, 364], [120, 364]], [[-0.235, 0.31, -0.62], [-0.235, 0.31, -0.38]]),
    e(k('V_HF'), k('MIX'), 'supply', [[140, 364], [220, 364]], [[-0.235, 0.31, -0.34], [-0.235, 0.31, -0.185]]),
    e('src.HCl', k('V_HCl'), 'supply', [[64, 390], [120, 390]], [[-0.195, 0.31, -0.62], [-0.195, 0.31, -0.46]]),
    e(k('V_HCl'), k('MIX'), 'supply', [[140, 390], [220, 390]], [[-0.195, 0.31, -0.42], [-0.195, 0.31, -0.185]]),
    e(k('MIX'), k('TANK'), 'supply', [[230, 352], [230, 340], [372, 340], [372, 262]], [[-0.045, 0.31, -0.16], [-0.02, 0.31, -0.16], [-0.02, 0.597, -0.16]]),
    e(k('TANK'), k('PAN'), 'overflow', [[342, 153], [318, 153], [318, 300]], null, 'L'),
    e(k('TANK'), k('PAN'), 'overflow', [[458, 153], [482, 153], [482, 300]], null, 'R'),
    e(k('TANK'), k('V_QDR'), 'drain', [[430, 260], [430, 270]], [[0.171, 0.63, 0], [0.205, 0.63, 0], [0.205, 0.605, 0]]),
    e(k('V_QDR'), k('PAN'), 'drain', [[430, 292], [430, 300]], [[0.205, 0.545, 0], [0.205, 0.505, 0]]),
    e(k('PAN'), k('JD'), 'drain', [[490, 326], [490, 352]], [[0.20, 0.497, 0.12], [0.20, 0.365, 0.12]]),
    e(k('JD'), k('V_DA'), 'drain', [[494, 356], [530, 356], [530, 334], [560, 334]], [[0.185, 0.35, 0.12], [0.15, 0.35, 0.12], [0.15, 0.27, 0.12]]),
    e(k('JD'), k('V_DREC'), 'drain', [[494, 356], [530, 356], [530, 384], [560, 384]], [[0.215, 0.35, 0.12], [0.25, 0.35, 0.12], [0.25, 0.27, 0.12]]),
    e(k('V_DA'), 'sink.acid', 'drain', [[580, 334], [604, 334]], [[0.15, 0.23, 0.12], [0.15, 0.10, 0.12], [0.15, 0.10, -0.46]]),
    e(k('V_DREC'), 'sink.reclaim', 'drain', [[580, 384], [604, 384]], [[0.25, 0.23, 0.12], [0.25, 0.18, 0.12], [0.25, 0.18, -0.54]]),
    // IPA
    e('src.IPA', k('V_IPA'), 'supply', [[64, 128], [140, 128]], [[0.04, 1.06, -0.62], [0.04, 1.06, -0.38]]),
    e(k('V_IPA'), k('NOZ_IPA'), 'supply', [[160, 128], [366, 128], [366, 132]], [[0.04, 1.06, -0.34], [0.04, 1.06, -0.236], [0.04, 1.03, -0.236], [0.04, 1.03, -0.208]]),
    e(k('NOZ_IPA'), k('TANK'), 'spray', [[366, 146], [366, 156]], null),     // IPA 只在水面上铺一层，不把水顶出去
    // N₂：置换、吹干、破真空
    e('src.N2', k('V_N2'), 'supply', [[64, 60], [140, 60]], [[-0.12, 1.38, -0.62], [-0.12, 1.38, -0.38]]),
    e(k('V_N2'), k('NOZ_N2'), 'supply', [[160, 60], [392, 60], [392, 67]], [[-0.12, 1.38, -0.34], [-0.12, 1.38, -0.236], [-0.12, 1.38, -0.208]]),
    e(k('NOZ_N2'), k('CH'), 'supply', [[392, 82], [392, 96]], null),
    e('src.N2', k('V_VENT'), 'supply', [[64, 100], [140, 100]], [[-0.04, 1.30, -0.62], [-0.04, 1.30, -0.38]]),
    e(k('V_VENT'), k('CH'), 'supply', [[160, 100], [300, 100]], [[-0.04, 1.30, -0.34], [-0.04, 1.30, -0.238]]),
    // 抽真空、排气（气体从密封腔出去）
    e(k('CH'), k('V_VAC'), 'vac', [[510, 60], [535, 60]], [[-0.228, 1.25, 0.15], [-0.27, 1.25, 0.15], [-0.27, 0.83, 0.15]]),
    e(k('V_VAC'), k('TRAP'), 'vac', [[555, 60], [576, 60]], [[-0.27, 0.77, 0.15], [-0.27, 0.47, 0.15], [-0.05, 0.47, 0.15], [-0.05, 0.445, 0.15]]),
    e(k('TRAP'), k('VP'), 'vac', [[600, 72], [600, 104]], [[-0.05, 0.36, 0.15], [-0.05, 0.31, 0.15]]),
    e(k('VP'), 'sink.exOrg', 'vac', [[600, 132], [600, 171]], [[-0.05, 0.14, 0.06], [-0.05, 0.14, -0.62]]),
    e(k('CH'), k('V_EXH'), 'vent', [[510, 110], [535, 110]], [[0.10, 1.30, -0.238], [0.10, 1.30, -0.38]]),
    e(k('V_EXH'), 'sink.exOrg', 'vent', [[555, 110], [566, 110], [566, 180], [576, 180]], [[0.10, 1.30, -0.34], [0.10, 1.30, -0.62]]),
  ];
  // 仪表：压力、氧浓度在密封腔，比电阻在槽里
  const inst = [
    { id: k('PT'), tag: 'PT', label: '压力', at: [232, 172], to: [292, 172], on: k('CH') },
    { id: k('OT'), tag: 'O₂', label: '氧浓度', at: [232, 212], to: [292, 212], on: k('CH') },
    { id: k('AT'), tag: 'AT', label: '比电阻', at: [575, 236], to: [456, 236], on: k('TANK') },
  ];
  const p3 = {
    [k('V_CDIW')]: [-0.29, 0.15, -0.36], [k('V_HF')]: [-0.235, 0.31, -0.36], [k('V_HCl')]: [-0.195, 0.31, -0.44], [k('MIX')]: [-0.155, 0.31, -0.16],
    [k('V_QDR')]: [0.205, 0.575, 0], [k('JD')]: [0.20, 0.35, 0.12], [k('V_DA')]: [0.15, 0.25, 0.12], [k('V_DREC')]: [0.25, 0.25, 0.12],
    [k('V_IPA')]: [0.04, 1.06, -0.36], [k('V_N2')]: [-0.12, 1.38, -0.36], [k('V_VENT')]: [-0.04, 1.30, -0.36],
    [k('V_VAC')]: [-0.27, 0.80, 0.15], [k('TRAP')]: [-0.05, 0.40, 0.15], [k('VP')]: [-0.05, 0.20, 0.15], [k('V_EXH')]: [0.10, 1.30, -0.36],
  };
  const size3 = { [k('MIX')]: [0.22, 0.05, 0.05], [k('TRAP')]: [0.07, 0.08, 0.07] };
  const act3 = { [k('V_QDR')]: 'z', [k('V_DA')]: 'z', [k('V_DREC')]: 'z', [k('V_VAC')]: 'z' };
  const box2 = {
    out: [290, 36, 220, 292], in: [340, 150, 120, 110], outId: k('CH'), inId: k('TANK'), outLabel: '密封腔', inLabel: '槽（晶圆）', outLabelAt: [296, 50, 'start'],
    extra: [{ id: k('PAN'), rect: [292, 302, 216, 24], label: '接液槽' }],
  };
  const hdr3 = [[0.10, -0.46, 0.5], [0.18, -0.54, 0.5]];
  const legend = ['DIW', 'HF', 'RA', 'IPA', 'IPAV', 'N2'];
  const rules = {
    inject: { [k('V_HF')]: 'HF', [k('V_HCl')]: 'HCl' }, carrier: [k('V_CDIW')],
    dryer: { ipa: k('V_IPA'), vac: k('V_VAC') },
  };
  return { id, type: 'dryer', nodes, edges, inst, fac, p3, size3, act3, box2, hdr3, legend, rules };
}

// ---------- 从单槽的状态推出阀门、槽的状态 ----------
// 排液分流规则（原创）：注药时按注的药切（不等槽里浓度上来）；不注药时按槽里的液体切：
// 干净的 DIW → 回收；碱 → 碱排液；其余（酸、还没冲干净的冲洗水、H₂O₂）→ 酸排液。
// 回收另外加两条（作者选的）：快排永远不进回收；冲干净以后还要再溢流 P.reclaimDelayS 才切回收，
// 先把接液槽和排液管里残留的脏水冲走（快排和溢流共用这根排液管）
export function drainFor(f) {
  if (f === 'DIW') return 'V_DREC';
  return FLUID_CLASS[f] === 'alk' ? 'V_DK' : 'V_DA';
}

export function oneBathState(id, ob, state = { open: {}, run: {}, tank: {} }) {
  const k = s => `${id}.${s}`, o = state.open;
  const sup = ob.Q > 0, hot = sup && ob.Tin > P.coldC + 1;
  o[k('V_CDIW')] = sup && !hot;
  o[k('V_HOT')] = hot;
  for (const v in OB_INJECT) o[k(v)] = false;
  const inj = ob.inject;
  if (inj) {
    let v = Object.keys(OB_INJECT).find(x => OB_INJECT[x] === inj.species);
    if (inj.species === 'H2O2') v = ob.Q / (inj.ratio + 1) < OB.h2o2SmallMaxLpm ? 'V_H2O2S' : 'V_H2O2L';
    o[k(v)] = true;
  }
  o[k('V_SH')] = (ob.dumping && ob.shower) || (ob.refillShower && ob.level < 0.9);
  o[k('V_QDR')] = ob.dumping;
  const fluid = ob.fluid();
  // 有液体进接液槽（快排，或者满槽还在供液 → 溢流）时，才打开对应的那一路
  const toPan = ob.dumping || (ob.full && sup);
  let dest = drainFor(inj ? inj.species : fluid);
  if (dest === 'V_DREC' && (ob.dumping || ob.cleanS < P.reclaimDelayS)) dest = 'V_DA';
  for (const v of OB_DRAIN) o[k(v)] = toPan && v === dest;
  state.tank[k('TANK')] = { fluid, full: ob.full };
  return state;
}

// ---------- 从减压干燥槽的状态推出阀门、槽的状态 ----------
// 槽里的水和单槽一样（冷 DIW、注药、排水、排液分流的规则都一样）；气体这边按干燥的步骤
export function dryerState(id, dr, state = { open: {}, run: {}, tank: {} }) {
  oneBathState(id, dr.liq, state);
  const k = s => `${id}.${s}`, o = state.open, closed = dr.lid > 0.99, atm = dr.pressure >= 99;
  o[k('V_N2')] = dr.n2On;
  o[k('V_IPA')] = dr.ipaOn;
  o[k('V_VAC')] = dr.vacOn;
  state.run[k('VP')] = dr.vacOn;
  o[k('V_EXH')] = closed && !dr.vacOn && atm;     // 关着盖、常压：一直排气（注药时的雾气、N₂、IPA 蒸气都从这里走）
  o[k('V_VENT')] = closed && !dr.vacOn && !atm;                           // 减压以后用 N₂ 回到大气压
  const gas = !closed ? 'air' : dr.ipaOn || dr.ipa > 0.05 ? 'IPAV' : dr.o2 < 20 ? 'N2' : 'air';
  state.tank[k('CH')] = { fluid: gas, full: false };
  (state.dryer ||= {})[id] = { lid: dr.lid, o2: dr.o2 };
  return state;
}

// ---------- 联锁检查（用管路状态）：返回违反的条目 ----------
function accepts(sink, f) {
  if (sink.accepts === 'gas') return true;
  if (sink.accepts === 'clean') return f === 'DIW';     // 回收只收干净的 DIW
  const c = FLUID_CLASS[f];
  return c === 'neutral' || c === sink.accepts;
}

export function checkInterlocks(G, state, flows, blocked = []) {
  const bad = [];
  for (const id in G.nodes) {
    const n = G.nodes[id];
    if (n.kind === 'heater' && state.heater && state.heater[id]) {
      const flowing = G.inn[id].some(e => flows[e.id]);
      if (!flowing) bad.push(`${id}：加热器开着但没有液体流过（会空烧）`);
    }
    // 分流点：同时只能走一路
    if (n.kind === 'junction') {
      const outs = G.out[id].filter(e => e.sys === 'drain' && flows[e.id]);
      if (outs.length > 1) bad.push(`${id}：排液同时走了 ${outs.length} 路`);
    }
  }
  for (const e of G.edges) {
    const f = flows[e.id];
    if (!f) continue;
    const sink = G.nodes[e.b];
    if (sink.kind === 'sink' && !accepts(sink, f)) bad.push(`${e.id}：${FLUID_NAME[f]} 流进了${sink.label}`);
  }
  for (const id of blocked) bad.push(`${id}：${G.nodes[id].label}有液体进来，但排液阀全关（会满出来）`);
  // 单槽：酸和碱不能同时注；注药时必须有 DIW 在流（否则原液直接进槽）
  for (const t of G.templates) {
    if (!t.rules) continue;
    const inj = Object.keys(t.rules.inject).filter(v => state.open[v]);
    const cls = new Set(inj.map(v => FLUID_CLASS[t.rules.inject[v]]));
    if (cls.has('acid') && cls.has('alk')) bad.push(`${t.id}：酸和碱的注入阀同时开着`);
    if (inj.length && !t.rules.carrier.some(v => state.open[v])) bad.push(`${t.id}：注药时 DIW 没在流（原液直接进槽，配比不对）`);
    // 干燥槽：IPA 可燃，盖子关好、氧降到 2 % 以下才能开 IPA 阀；盖子关好才能抽真空
    const dr = t.rules.dryer, ds = state.dryer && state.dryer[t.id];
    if (dr && ds) {
      if (state.open[dr.ipa] && (ds.lid < 0.99 || ds.o2 > 2)) bad.push(`${t.id}：盖子没关好或氧浓度没降下来就开了 IPA 阀`);
      if (state.open[dr.vac] && ds.lid < 0.99) bad.push(`${t.id}：盖子没关就抽真空`);
    }
  }
  return bad;
}
