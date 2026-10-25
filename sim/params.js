// 全部可调参数集中在这里。方括号里的出处编号见 docs/资料来源.md；没写出处的都是估计值（原创初值）。

export const P = {
  // ---- 晶圆和批（规格 2 节）----
  nWafer: 50,            // 一批 50 片（两盒合批）
  nPerFoup: 25,
  pitch: 0.005,          // 槽里的间距 5 mm（半间距）
  foupPitch: 0.010,      // FOUP 里 10 mm [FOUP-wiki]
  waferD: 0.300,         // [SEMI-M1]
  waferT: 775e-6,        // [SEMI-M1]

  // ---- 槽（规格 3 节，资料来源 D1）----
  Vliq: 42,              // 槽内液体 L
  cbVol: 55,             // 药液槽连外槽和管路的药液总量 L
  innerL: 0.33, innerW: 0.35, innerH: 0.40,   // 内槽 长（沿片排列）× 宽 × 深，m

  // ---- 单槽（规格 6.2 节）----
  refillLpm: 60,         // 快排后补水流量（底部进水；开淋浴时再加淋浴的水）
  dumpS: 5,              // 快排排空时间
  qdrResidual: 0.02,     // 排空后残液比例 f（资料来源 D2）
  showerLpm: 20,         // 排空时淋浴流量
  showerMix: 0.3,        // 淋浴水里真正和残液混合的比例
  coldC: 25,             // 冷 DIW 温度
  ambientC: 25,
  tauLossS: 10000,       // 槽液自然散热时间常数（集总热容估算）
  rhoEveryS: 0.5,        // 比电阻每隔多久算一次（过程时间）

  // ---- 药液原液浓度 mol/L（49 % HF、29 % NH₃、30 % H₂O₂、96 % H₂SO₄、37 % HCl，密度取常用值）----
  stock: { HF: 28.2, NH3: 15.3, H2O2: 9.8, H2SO4: 18.0, HCl: 12.0 },
  dragOutL: 0.4,         // 每批晶圆从药液槽带出的药液（液膜，量级同 D2）

  // ---- 搬送（规格 6.6 节）----
  robotSpeed: 0.5,       // m/s
  liftSpeed: 0.1,        // 升降器快速升降 m/s
  liftTravel: 0.39,      // 交接位置 ↔ 浸没位置 m
  handoffS: 3,           // 机械手 ↔ 升降器交接
  chuckWashS: 30, chuckDryS: 10,   // 夹爪清洗、N₂ 吹干

  // ---- 线上各站的 X 坐标（m，原创布局，槽距 0.6 m）----
  X: { loader: -2.4, chuck: -1.6, cb1: -0.9, ob1: -0.3, cb2: 0.3, ob2: 0.9, dr: 1.5 },
};

export const TANKS = ['cb1', 'ob1', 'cb2', 'ob2', 'dr'];

export const STATION_NAME = {
  loader: '装载区', chuck: '夹爪清洗干燥位', cb1: '药液槽 1', ob1: '单槽 1', cb2: '药液槽 2', ob2: '单槽 2', dr: '减压干燥槽',
};
