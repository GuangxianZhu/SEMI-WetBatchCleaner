// 配方：默认值、预置配方（含几个"错误配方"）、配方页的输入项。
// 配比和温度取公开资料里的典型值（docs/规格.md 6、7 节），时间和流量是原创初值。

export const DEFAULT = {
  // 药液槽 1：SPM
  spmRatio: 4, spmT: 120, spmMin: 10,
  // 单槽 1
  ob1HotQdr: 2, ob1ColdQdr: 1, hotT: 70,
  // 药液槽 2：SC1（NH₄OH : H₂O₂ : H₂O = sc1Nh3 : 1 : sc1Water）
  sc1Nh3: 1, sc1Water: 5, sc1T: 75, sc1Min: 10, mega: 1, megaP: 100,
  // 单槽 2
  ob2Qdr: 2, dhfRatio: 100, dhfS: 60,
  // 单槽共用
  upflowLpm: 30, shower: 1,
  rinseMode: 'rho', rinseRho: 15, rinseMinS: 300, rinseTimeS: 600,
  // 减压干燥槽
  ipa: 1, liftMmS: 1.0, vacuum: 1,
  // 搬送：机械手在半路被耽误的时间（模拟搬得慢）
  airExtraS: 0,
};

export const PRESETS = [
  { id: 'std', name: '标准（推荐）', r: {} },
  { id: 'sc1hot', name: 'SC1 太浓太热', r: { sc1Nh3: 3, sc1T: 80 } },
  { id: 'nomega', name: '不开兆声', r: { mega: 0 } },
  { id: 'dhflong', name: 'DHF 太久', r: { dhfS: 240 } },
  { id: 'shortrinse', name: '冲洗不够就走', r: { ob1HotQdr: 0, ob1ColdQdr: 0, ob2Qdr: 0, rinseMode: 'time', rinseTimeS: 60 } },
  { id: 'noshower', name: '快排不开淋浴', r: { shower: 0 } },
  { id: 'slow', name: '搬得太慢', r: { airExtraS: 45 } },
  { id: 'fastlift', name: '提拉太快', r: { liftMmS: 5 } },
  { id: 'noipa', name: '不用 IPA', r: { ipa: 0 } },
].map(p => ({ ...p, r: { ...DEFAULT, ...p.r } }));

// type：range（滑杆）/ toggle（开关）/ select
export const FIELDS = [
  { grp: '药液槽 1 · SPM' },
  { k: 'spmRatio', name: 'H₂SO₄ : H₂O₂', unit: ': 1', min: 2, max: 8, step: 0.5, tip: '硫酸多，氧化力和温度更稳；双氧水多，反应更猛但消耗快' },
  { k: 'spmT', name: '温度', unit: '°C', min: 80, max: 150, step: 5, tip: '温度越高，有机物去得越快' },
  { k: 'spmMin', name: '时间', unit: 'min', min: 1, max: 20, step: 1, tip: '' },
  { grp: '单槽 1 · SPM 之后的冲洗' },
  { k: 'ob1HotQdr', name: '热水快排冲洗', unit: '次', min: 0, max: 4, step: 1, tip: '硫酸黏、难冲，先用热水快排几次' },
  { k: 'ob1ColdQdr', name: '冷水快排冲洗', unit: '次', min: 0, max: 4, step: 1, tip: '' },
  { k: 'hotT', name: '热水温度', unit: '°C', min: 40, max: 80, step: 5, tip: '' },
  { grp: '药液槽 2 · SC1' },
  { k: 'sc1Nh3', name: 'NH₄OH 份数', unit: '', min: 0.1, max: 3, step: 0.1, tip: '经典配比 1 : 1 : 5。氨水越多，颗粒去得越干净，硅也被刻得越多' },
  { k: 'sc1Water', name: '水的份数', unit: '', min: 5, max: 100, step: 5, tip: '加水稀释：硅损失小，去颗粒靠兆声补' },
  { k: 'sc1T', name: '温度', unit: '°C', min: 25, max: 80, step: 5, tip: '' },
  { k: 'sc1Min', name: '时间', unit: 'min', min: 1, max: 20, step: 1, tip: '' },
  { k: 'mega', name: '兆声', type: 'toggle', tip: '约 1 MHz 的声波，帮忙把小颗粒冲走' },
  { k: 'megaP', name: '兆声功率', unit: '%', min: 0, max: 100, step: 10, tip: '' },
  { grp: '单槽 2 · DHF' },
  { k: 'ob2Qdr', name: 'SC1 之后快排冲洗', unit: '次', min: 0, max: 4, step: 1, tip: '' },
  { k: 'dhfRatio', name: 'DHF 稀释比 1 :', unit: '', min: 50, max: 1000, step: 50, tip: '49 % HF 原液 : DIW' },
  { k: 'dhfS', name: '注入时间', unit: 's', min: 0, max: 300, step: 10, tip: '满槽边进边溢，浓度慢慢爬升；刻蚀量 = 整条浓度曲线的积分' },
  { grp: '单槽共用' },
  { k: 'upflowLpm', name: '上流流量', unit: 'L/min', min: 10, max: 60, step: 5, tip: '流量越大置换越快，DIW 用得越多' },
  { k: 'shower', name: '快排时开淋浴', type: 'toggle', tip: '排空那几秒让晶圆保持湿润，防图形倒塌' },
  { k: 'rinseMode', name: '冲洗终点', type: 'select', options: [['rho', '比电阻 + 最短时间'], ['time', '只按时间']], tip: '' },
  { k: 'rinseRho', name: '比电阻判定值', unit: 'MΩ·cm', min: 5, max: 18, step: 0.5, tip: '25 °C 纯水是 18.18' },
  { k: 'rinseMinS', name: '最短上流时间', unit: 's', min: 0, max: 900, step: 30, tip: '' },
  { k: 'rinseTimeS', name: '只按时间时的上流时间', unit: 's', min: 30, max: 1800, step: 30, tip: '' },
  { grp: '减压干燥槽' },
  { k: 'ipa', name: 'IPA', type: 'toggle', tip: 'IPA 把缝里的水换掉，表面张力只有水的约 1/3' },
  { k: 'liftMmS', name: '提拉速度', unit: 'mm/s', min: 0.2, max: 6, step: 0.2, tip: '提得太快，水膜来不及被拉走' },
  { k: 'vacuum', name: '减压', type: 'toggle', tip: '压力低，残留液体在低温下很快蒸发，氧也少' },
  { grp: '搬送' },
  { k: 'airExtraS', name: '机械手半路耽误', unit: 's', min: 0, max: 90, step: 5, tip: '模拟机械手被别的任务占住，晶圆在空气里待得更久' },
];

export const sameRecipe = (a, b) => Object.keys(DEFAULT).every(k => a[k] === b[k]);
