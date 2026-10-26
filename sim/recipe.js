// 配方分三层：
//   流程（flow）：整批走哪些槽、按什么顺序。现在固定是标准清洗：药液槽 1 → 单槽 1 → 药液槽 2 → 单槽 2 → 减压干燥槽
//   单元（unit）：一个槽里做什么。药液槽的单元带槽的条件（配比、温度）
//   步骤（step）：一步做多久、用什么药、什么温度……按步骤的种类有不同的项
// 配比和温度取公开资料里的典型值（docs/规格.md 6、7 节），时间和流量是原创初值。

// 线上的槽各是什么类型、有什么硬件
export const BATHS = {
  cb1: { type: 'chembath', kind: 'SPM', name: '药液槽 1' },
  ob1: { type: 'onebath', name: '单槽 1' },
  cb2: { type: 'chembath', kind: 'SC1', mega: true, name: '药液槽 2' },
  ob2: { type: 'onebath', name: '单槽 2' },
  dr: { type: 'dryer', name: '减压干燥槽', chems: ['HF', 'HCl'] },     // 干燥槽的注药只接了 HF、HCl
};

// 步骤的种类：每种有哪些项（配方页按这个画输入框）。baths：能用在哪几种槽；when：这一项什么时候才有意义；
// need：槽要有这个硬件；chems：下拉框只列这个槽接了的药
export const STEP_KINDS = {
  soak: {
    name: '浸泡', baths: ['chembath'], fields: [
      { k: 's', name: '时间', unit: 's', min: 10, max: 3600, step: 10 },
      { k: 'mega', name: '兆声', unit: '%', min: 0, max: 100, step: 10, need: 'mega', tip: '约 1 MHz 的声波，帮忙把小颗粒冲走；0 = 不开' },
    ],
  },
  qdr: {
    name: '快排冲洗', baths: ['onebath'], fields: [
      { k: 'T', name: '补水', unit: '°C', min: 25, max: 80, step: 5, tip: '快排后从槽底补水的温度。硫酸黏、难冲，SPM 之后先用热水' },
      { k: 'shower', name: '淋浴', type: 'toggle', tip: '排空那几秒让晶圆保持湿润，防图形倒塌' },
    ],
  },
  upflow: {
    name: '上流冲洗', baths: ['onebath', 'dryer'], fields: [
      { k: 'lpm', name: '流量', unit: 'L/min', min: 10, max: 60, step: 5, tip: '流量越大置换越快，DIW 用得越多' },
      { k: 'T', name: '温度', unit: '°C', min: 25, max: 80, step: 5 },
      { k: 'end', name: '结束', type: 'select', options: [['rho', '按比电阻'], ['time', '按时间']] },
      { k: 'rho', name: '比电阻 ≥', unit: 'MΩ·cm', min: 5, max: 18, step: 0.5, when: s => s.end === 'rho', tip: '25 °C 纯水是 18.18' },
      { k: 'minS', name: '至少', unit: 's', min: 0, max: 1800, step: 30, when: s => s.end === 'rho' },
      { k: 's', name: '时间', unit: 's', min: 30, max: 3600, step: 30, when: s => s.end === 'time' },
    ],
  },
  inject: {
    name: '注药', baths: ['onebath', 'dryer'], fields: [
      { k: 'chem', name: '药液', type: 'select', options: [['HF', 'HF'], ['HCl', 'HCl'], ['NH3', 'NH₄OH'], ['H2O2', 'H₂O₂']], chems: true },
      { k: 'ratio', name: '稀释 1 :', unit: '', min: 10, max: 1000, step: 10, tip: '原液 : DIW' },
      { k: 'lpm', name: '流量', unit: 'L/min', min: 10, max: 60, step: 5 },
      { k: 's', name: '时间', unit: 's', min: 10, max: 600, step: 10, tip: '满槽边进边溢，浓度慢慢爬升；刻蚀量 = 整条浓度曲线的积分' },
    ],
  },
  purge: { name: 'N₂ 置换', baths: ['dryer'], fields: [{ k: 'maxS', name: '最长', unit: 's', min: 30, max: 600, step: 30, tip: '把氧赶到 1 % 以下就进下一步；IPA 可燃，氧没降下来不能供 IPA' }] },
  ipa: { name: 'IPA 供给', baths: ['dryer'], fields: [{ k: 's', name: '时间', unit: 's', min: 10, max: 300, step: 10, tip: '在水面上形成一层 IPA，之后一直供到提拉结束' }] },
  lift: { name: '慢速提拉', baths: ['dryer'], fields: [{ k: 'mmS', name: '速度', unit: 'mm/s', min: 0.2, max: 6, step: 0.2, tip: '提得太快，水膜来不及被拉走' }] },
  vacuum: { name: '减压', baths: ['dryer'], fields: [{ k: 's', name: '时间', unit: 's', min: 10, max: 300, step: 10, tip: '压力低，残留液体在低温下很快蒸发，氧也少' }] },
  n2dry: { name: 'N₂ 吹干', baths: ['dryer'], fields: [{ k: 's', name: '时间', unit: 's', min: 10, max: 600, step: 10 }] },
};

// 新加一步时的默认值
export function newStep(kind) {
  return {
    soak: { kind, s: 600, mega: 0 },
    qdr: { kind, T: 25, shower: 1 },
    upflow: { kind, lpm: 30, T: 25, end: 'rho', rho: 15, minS: 300, s: 600 },
    inject: { kind, chem: 'HF', ratio: 100, lpm: 30, s: 60 },
    purge: { kind, maxS: 180 },
    ipa: { kind, s: 60 },
    lift: { kind, mmS: 1.0 },
    vacuum: { kind, s: 40 },
    n2dry: { kind, s: 60 },
  }[kind];
}

// 药液槽的条件（换液时按这个配；跑批时当恒定）
export const COND_FIELDS = {
  SPM: [
    { k: 'ratio', name: 'H₂SO₄ : H₂O₂', unit: ': 1', min: 2, max: 8, step: 0.5, tip: '硫酸多，氧化力和温度更稳；双氧水多，反应更猛但消耗快' },
    { k: 'T', name: '温度', unit: '°C', min: 80, max: 150, step: 5, tip: '温度越高，有机物去得越快' },
  ],
  SC1: [
    { k: 'nh3', name: 'NH₄OH 份数', unit: '', min: 0.1, max: 3, step: 0.1, tip: '经典配比 1 : 1 : 5。氨水越多，颗粒去得越干净，硅也被刻得越多' },
    { k: 'water', name: '水的份数', unit: '', min: 5, max: 100, step: 5, tip: '加水稀释：硅损失小，去颗粒靠兆声补' },
    { k: 'T', name: '温度', unit: '°C', min: 25, max: 80, step: 5 },
  ],
};

const S = newStep;
const with_ = (st, o) => ({ ...st, ...o });

// 标准清洗
export const DEFAULT = {
  flow: { name: '标准清洗', units: ['spm', 'rinse1', 'sc1', 'dhf', 'dry'], airExtraS: 0 },
  units: {
    spm: { name: 'SPM 去有机物', bath: 'cb1', cond: { ratio: 4, T: 120 }, steps: [S('soak')] },
    rinse1: {
      name: 'SPM 后冲洗', bath: 'ob1',
      steps: [with_(S('qdr'), { T: 70 }), with_(S('qdr'), { T: 70 }), S('qdr'), S('upflow')],
    },
    sc1: { name: 'SC1 + 兆声', bath: 'cb2', cond: { nh3: 1, water: 5, T: 75 }, steps: [with_(S('soak'), { mega: 100 })] },
    dhf: { name: 'SC1 后冲洗 → DHF → 冲洗', bath: 'ob2', steps: [S('qdr'), S('qdr'), S('upflow'), S('inject'), S('upflow')] },
    dry: { name: 'IPA 减压干燥', bath: 'dr', steps: [S('purge'), S('ipa'), S('lift'), S('vacuum'), S('n2dry')] },
  },
};

export const cloneRecipe = r => JSON.parse(JSON.stringify(r));
export const sameRecipe = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 流程里用到某个槽的单元
export const unitOfBath = (r, bath) => r.flow.units.map(id => r.units[id]).find(u => u.bath === bath);

// 预置配方：标准 + 几个"错误配方"，每个错在一项上（测试里检查）
const preset = (id, name, edit) => { const r = cloneRecipe(DEFAULT); edit(r); return { id, name, r }; };
const allSteps = (r, kind) => Object.values(r.units).flatMap(u => u.steps.filter(s => s.kind === kind));
export const PRESETS = [
  preset('std', '标准（推荐）', () => {}),
  preset('sc1hot', 'SC1 太浓太热', r => { Object.assign(r.units.sc1.cond, { nh3: 3, T: 80 }); }),
  preset('nomega', '不开兆声', r => { r.units.sc1.steps.forEach(s => { s.mega = 0; }); }),
  preset('dhflong', 'DHF 太久', r => { r.units.dhf.steps.find(s => s.kind === 'inject').s = 240; }),
  preset('shortrinse', '冲洗不够就走', r => {
    for (const u of [r.units.rinse1, r.units.dhf]) u.steps = u.steps.filter(s => s.kind !== 'qdr');
    allSteps(r, 'upflow').forEach(s => { s.end = 'time'; s.s = 60; });
  }),
  preset('noshower', '快排不开淋浴', r => { allSteps(r, 'qdr').forEach(s => { s.shower = 0; }); }),
  preset('slow', '搬得太慢', r => { r.flow.airExtraS = 45; }),
  preset('fastlift', '提拉太快', r => { allSteps(r, 'lift').forEach(s => { s.mmS = 5; }); }),
  preset('noipa', '不用 IPA', r => { r.units.dry.steps = r.units.dry.steps.filter(s => s.kind !== 'ipa'); }),
  // 不是错误配方：HF 放到干燥槽里做（单槽 2 只冲洗），HF 之后晶圆不出液面直接干燥
  preset('hfdry', 'HF 放到干燥槽里', hfInDryer),
  preset('slowhfdry', '搬得太慢，但 HF 在干燥槽里', r => { hfInDryer(r); r.flow.airExtraS = 45; }),
];
function hfInDryer(r) {
  const ob = r.units.dhf;
  ob.name = 'SC1 后冲洗';
  ob.steps = ob.steps.slice(0, 3);              // 快排 ×2 → 上流冲洗
  r.units.dry.name = 'HF → 冲洗 → IPA 减压干燥';
  r.units.dry.steps = [{ ...S('inject'), lpm: 30 }, S('upflow'), ...r.units.dry.steps];
}

// 从配方里归纳出几件事（结果页的提示用）
export function recipeFacts(r) {
  const used = r.flow.units.map(id => r.units[id]);
  const steps = kind => used.flatMap(u => u.steps.filter(s => s.kind === kind));
  const megaSteps = used.filter(u => BATHS[u.bath].mega).flatMap(u => u.steps.filter(s => s.kind === 'soak'));
  const lift = steps('lift')[0];
  return {
    megaP: megaSteps.length ? Math.max(...megaSteps.map(s => s.mega || 0)) : 0,
    shower: steps('qdr').every(s => s.shower),
    ipa: steps('ipa').length > 0,
    vacuum: steps('vacuum').length > 0,
    liftMmS: lift ? lift.mmS : 1.0,
  };
}

// 一个步骤写成一句话（流程卡片、步骤说明用）
const CHEM = { HF: 'HF', HCl: 'HCl', NH3: 'NH₄OH', H2O2: 'H₂O₂' };
export function describeStep(s) {
  switch (s.kind) {
    case 'soak': return `浸泡 ${s.s} s${s.mega ? `，兆声 ${s.mega} %` : ''}`;
    case 'qdr': return `快排冲洗（补水 ${s.T} °C${s.shower ? '' : '，不开淋浴'}）`;
    case 'upflow': return `上流冲洗 ${s.lpm} L/min${s.T > 30 ? ` ${s.T} °C` : ''}，${s.end === 'rho' ? `到比电阻 ≥ ${s.rho} MΩ·cm（至少 ${s.minS} s）` : `${s.s} s`}`;
    case 'inject': return `注药 ${CHEM[s.chem]} 1 : ${s.ratio}，${s.lpm} L/min，${s.s} s`;
    case 'purge': return `N₂ 置换（最长 ${s.maxS} s）`;
    case 'ipa': return `IPA 供给 ${s.s} s`;
    case 'lift': return `慢速提拉 ${s.mmS} mm/s`;
    case 'vacuum': return `减压 ${s.s} s`;
    case 'n2dry': return `N₂ 吹干 ${s.s} s`;
    default: return s.kind;
  }
}
// 连续一样的步骤合并成"×n"
export function describeSteps(steps) {
  const out = [];
  for (const s of steps) {
    const d = describeStep(s), last = out[out.length - 1];
    if (last && last.d === d) last.n++; else out.push({ d, n: 1 });
  }
  return out.map(o => (o.n > 1 ? `${o.d} ×${o.n}` : o.d)).join(' → ') || '（没有步骤）';
}
export function describeCond(u) {
  const b = BATHS[u.bath];
  if (b.kind === 'SPM') return `SPM（H₂SO₄ : H₂O₂ = ${u.cond.ratio} : 1，${u.cond.T} °C）`;
  if (b.kind === 'SC1') return `SC1（NH₄OH : H₂O₂ : H₂O = ${u.cond.nh3} : 1 : ${u.cond.water}，${u.cond.T} °C）`;
  return '';
}
