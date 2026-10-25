// 槽式清洗机 · 跑一批晶圆
// 工艺和设备都在 sim/ 里算（纯 JS，node 能单独测），这里只负责画和操作。
// 坐标：米，+Y 向上；整条线沿 X 方向，槽的中心在 z = 0，机械手的导轨在后面（-Z）。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { P, TANKS, STATION_NAME } from '../sim/params.js';
import { Line, simulate, PIPING } from '../sim/tool.js';
import { FLUID_NAME } from '../sim/piping.js';
import { evaluate } from '../sim/result.js';
import { DEFAULT, PRESETS, BATHS, STEP_KINDS, COND_FIELDS, newStep, cloneRecipe, sameRecipe, describeSteps } from '../sim/recipe.js';
import { SURF, gammaMix, stressGPa } from '../sim/surface.js';
import { initParts, ballValve, megaTransducer, megaGenerator, meter, resistivityProbe, rtdProbe, levelProbe, magPump, filterHousing, inlineHeater, flowControl, mixingBlock, nozzleRow, cable } from './parts3d.js';

const $ = s => document.querySelector(s);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const X = P.X;

// 槽的竖直尺寸：内槽底 Y_BOTTOM，槽口 Y_TOP；晶圆中心浸没时 Y_DOWN，交接位置 Y_HAND
const Y_BOTTOM = 0.60, Y_TOP = Y_BOTTOM + P.innerH, Y_DOWN = Y_BOTTOM + 0.06 + P.waferD / 2, Y_HAND = Y_DOWN + P.liftTravel;
const waferY = z => Y_DOWN + (Y_HAND - Y_DOWN) * z;
const IL = P.innerL, IW = P.innerW, IH = P.innerH;
const PIVOT = new THREE.Vector3(X.loader, Y_HAND, 0);       // 姿态变换单元的转轴
const FOUP_X = { 1: -3.05, 2: -2.62 }, FOUP_Z = 0.58, FOUP_Y0 = 0.975;

// ================= 渲染器、场景、镜头 =================
const stage = $('#stage');
// 手机、平板，或者地址后面加了 ?lite：关掉阴影、降低分辨率
const LOW = matchMedia('(pointer: coarse)').matches || innerWidth < 900 || /[?&]lite/.test(location.search);
const canvas = $('#c');
let renderer, has3D = true;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
catch (e) {
  has3D = false;
  renderer = { setPixelRatio() {}, setSize() {}, render() {} };
  const m = document.createElement('div');
  m.className = 'no3d';
  m.textContent = '这台设备的浏览器不支持 3D（WebGL2），3D 机台显示不了。工艺照样能跑：看右边的步骤说明和左下角的面板。';
  stage.appendChild(m);
  $('#labels').checked = false;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, LOW ? 1.5 : 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
const scene = new THREE.Scene();
if (has3D) scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight(0xdbe6f2, 0x2a2f35, 0.4));
const sun = new THREE.DirectionalLight(0xfff3e4, 2.2);
sun.position.set(2.5, 7, 5);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xcfdcff, 0.4);
fill.position.set(-4, 3, -2);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.5);
rim.position.set(-1, 4, -5);
scene.add(rim);
if (has3D && !LOW) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 3, bottom: -3, near: 1, far: 20 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.015;
}
const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 60);
camera.position.set(-0.4, 2.9, 4.6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(-0.6, 0.9, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 0.12;
controls.maxDistance = 12;

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'labels';
stage.insertBefore(labelRenderer.domElement, $('#caption'));

// ================= 材质 =================
function std(color, metalness = 0.1, roughness = 0.55, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
}
const see = (color, opacity, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.08, metalness: 0, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, ...extra });
const MAT = {
  floor: std(0x8d959d, 0, 0.85),
  panel: std(0xbcc3c9, 0.05, 0.6),        // 机柜外壳
  wall: std(0xa3abb2, 0.05, 0.7),         // 后墙
  dark: std(0x4a525c, 0.1, 0.6),
  steel: std(0xb7bec6, 0.45, 0.35),
  resin: std(0xebe8de, 0, 0.5),           // 耐药树脂的管、阀、喷嘴（PFA / PVDF 之类）
  pump: std(0x4f6d8a, 0.2, 0.5),
  filter: std(0xeef1f3, 0, 0.45),
  heater: std(0xb3643c, 0.2, 0.5),
  wafer: std(0x7a8292, 0.55, 0.26),
  chuck: std(0xf2f1ea, 0, 0.4),           // 夹爪导杆
  lifter: std(0xe6e2d3, 0, 0.35),
  mega: std(0x9aa3ad, 0.5, 0.3),
  green: std(0x3e9b62), red: std(0xc8463c), amber: std(0xe0a32e), blue: std(0x2f6fb3),
  screen: std(0x1d2a36, 0.2, 0.3, { emissive: 0x16384f, emissiveIntensity: 0.6 }),
  foup: see(0x9fb2c4, 0.42),
  quartz: see(0xe6f3f9, 0.17),            // 石英槽
  glass: see(0xd8ecf5, 0.07),             // 机柜前板（透明时）
  actuator: std(0xd3d8dc, 0.05, 0.45),    // 气动执行器外壳
  indicator: std(0x9aa3ab, 0, 0.35),      // 阀门开关指示器（开 = 绿）
  cable: std(0x2b3036, 0, 0.75),
  electrode: std(0x8f979e, 0.65, 0.3),    // 比电阻计的电极（钛之类的金属）
  glassTube: see(0xdff2fa, 0.35),         // 流量计的玻璃管
};
initParts(MAT);
MAT.quartz.userData.pick = true;
MAT.foup.userData.pick = true;
MAT.glass.userData.noPick = true;
const EDGE = new THREE.LineBasicMaterial({ color: 0x86aec2, transparent: true, opacity: 0.85 });

// ================= 几何体小工具 =================
function mesh(geo, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; }
const box = (w, h, d, mat, x = 0, y = 0, z = 0) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
const cylY = (r, h, mat, x = 0, y = 0, z = 0, seg = 24) => mesh(new THREE.CylinderGeometry(r, r, h, seg), mat, x, y, z);
function cylX(r, len, mat, x = 0, y = 0, z = 0) { const m = mesh(new THREE.CylinderGeometry(r, r, len, 14), mat, x, y, z); m.rotation.z = Math.PI / 2; return m; }
function cylZ(r, len, mat, x = 0, y = 0, z = 0) { const m = mesh(new THREE.CylinderGeometry(r, r, len, 14), mat, x, y, z); m.rotation.x = Math.PI / 2; return m; }
function group(...objs) { const g = new THREE.Group(); objs.forEach(o => g.add(o)); return g; }
// 折线管子
function pipe(pts, r, mat) {
  const path = new THREE.CurvePath();
  for (let i = 1; i < pts.length; i++) path.add(new THREE.LineCurve3(new THREE.Vector3(...pts[i - 1]), new THREE.Vector3(...pts[i])));
  return new THREE.Mesh(new THREE.TubeGeometry(path, pts.length * 6, r, 8, false), mat);
}
// 石英槽：原点在内底中心
function quartzTank(L, W, H, t = 0.006) {
  const m = MAT.quartz, g = new THREE.Group();
  g.add(box(L + 2 * t, t, W + 2 * t, m, 0, -t / 2, 0));
  g.add(box(L + 2 * t, H, t, m, 0, H / 2, -W / 2 - t / 2));
  g.add(box(L + 2 * t, H, t, m, 0, H / 2, W / 2 + t / 2));
  g.add(box(t, H, W, m, -L / 2 - t / 2, H / 2, 0));
  g.add(box(t, H, W, m, L / 2 + t / 2, H / 2, 0));
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L + 2 * t, H + t, W + 2 * t)), EDGE);
  e.position.y = (H - t) / 2;
  e.userData.noPick = true;
  g.add(e);
  return g;
}
// 液体：底在 0，scale.y = 液面高度
function liquidBox(L, W, color, opacity = 0.24) {
  const geo = new THREE.BoxGeometry(L, 1, W);
  geo.translate(0, 0.5, 0);
  const mat = see(color, opacity, { side: THREE.FrontSide });
  mat.userData.noPick = true;
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 1;
  return m;
}

// ================= 零件表 =================
const PART_INFO = {
  lp1: ['装载口 1', '装载', '放 FOUP，FOUP 门和设备的门对接后一起打开。晶圆一直关在盒子里，开门也是对着设备里的洁净空间开。'],
  lp2: ['装载口 2', '装载', '同装载口 1。两个 FOUP 合成一批 50 片。'],
  foup1: ['FOUP 1', '装载', '晶圆盒：装 25 片，10 mm 间距，晶圆水平放。'],
  foup2: ['FOUP 2', '装载', '同 FOUP 1。'],
  mapper: ['晶圆映射传感器', '装载', '开门后上下扫一遍，查每个槽位有没有片、有没有叠片或斜片。'],
  batch_robot: ['批量取片机械手', '装载', '多叶片，一次从 FOUP 取出 25 片。合批时第二盒交错插进第一盒的空隙，间距从 10 mm 变成 5 mm。'],
  posture: ['姿态变换 / 合批单元', '装载', '把整批晶圆从水平转成竖直（进槽前），回程时再转回水平。'],
  robot: ['槽间搬送机械手', '搬送', '夹着整批 50 片在槽之间水平移动，全线只有一台。槽里的上下动作交给每个槽自己的升降器。'],
  rail: ['导轨', '搬送', '机械手沿着它在各站之间走。'],
  chuck_clean: ['夹爪清洗干燥位', '搬送', '冲洗夹爪，再用 N₂ 吹干。搬过药液里出来的晶圆以后要洗；从减压干燥槽取干片之前也要洗、吹干。都和槽里的处理同时进行，不占晶圆的时间，但占机械手的时间。'],
  frame: ['机架和外壳', '公共', ''],
  ffu: ['风机过滤单元', '公共', '从上往下送洁净空气。'],
  exhaust: ['排风口', '公共', '槽后面的排风口抽走药液蒸气；按酸 / 碱 / 有机切换。'],
  leak: ['接液盘 + 漏液传感器', '公共', '槽和管路下面的托盘，漏液时传感器动作，停止供液。'],
  ctrl: ['控制柜和操作屏', '公共', ''],
  tower: ['三色信号灯', '公共', '绿：运行；黄：等待或轻报警；红：重报警。'],
  emo: ['急停', '公共', '按下切断所有动作和供液。'],
  dr_tank: ['减压干燥槽 · 槽体', '减压干燥槽', '下面是水，水面上供 IPA，上面是密封的气体空间。晶圆从水里慢慢提上来，穿过 IPA 层到气体层。'],
  dr_lid: ['减压干燥槽 · 密封盖', '减压干燥槽', '关上才能减压、供 IPA。'],
  dr_ipa: ['减压干燥槽 · IPA 喷嘴', '减压干燥槽', '在水面上形成一层 IPA。IPA 和水完全互溶，界面会慢慢扩散成一段浓度梯度，所以要一直供。'],
  dr_n2: ['减压干燥槽 · N₂ 喷嘴', '减压干燥槽', '先把氧赶走（IPA 可燃，闪点 12 °C，爆炸下限 2 %），最后吹干。'],
  dr_vac: ['减压干燥槽 · 真空泵', '减压干燥槽', '减压：压力越低沸点越低，残留液体在低温下很快蒸发，氧也少。'],
  dr_lifter: ['减压干燥槽 · 升降器', '减压干燥槽', '慢速提拉：提得太快，水膜来不及被 Marangoni 效应拉走。'],
};
for (const [id, n, chem] of [['cb1', 1, 'SPM'], ['cb2', 2, 'SC1']]) {
  const g = `药液槽 ${n}（${chem}）`;
  Object.assign(PART_INFO, {
    [`${id}_inner`]: [`药液槽 ${n} · 内槽`, g, `石英槽。晶圆泡在这里；药液从底部进、从顶部溢流到外槽。一个槽只用一种药（${chem}），药液循环反复用。`],
    [`${id}_outer`]: [`药液槽 ${n} · 外槽`, g, '接住内槽溢流出来的药液，给循环泵当缓冲。内槽表面一直在更新，浮上来的颗粒被溢流带走。'],
    [`${id}_pump`]: [`药液槽 ${n} · 循环泵`, g, '磁力驱动泵：电机隔着泵壳用磁铁带动里面的叶轮，药液不经过轴封，不漏、不长颗粒。下面是 PFA 泵头，上面是电机。外槽 → 加热器 → 过滤器 → 内槽底部，一直在转；放在最前面，吸入侧没有阻力件，热药液不容易汽蚀。外槽液位太低时停（联锁）。'],
    [`${id}_filter`]: [`药液槽 ${n} · 过滤器`, g, 'PFA 外壳里装着滤芯，下进上出，顶上有排气阀（把气泡排掉）。拦住溢流带走的颗粒；放在最后，也拦住泵和加热器掉出来的颗粒。压差升高说明堵了，要换滤芯（消耗件）。'],
    [`${id}_heater`]: [`药液槽 ${n} · 加热器`, g, '管道加热器：药液从石英 / PFA 管里流过，外面是不锈钢外壳，上面是接线盒。把药液保持在设定温度。泵停了必须停：没有液体流过会空烧（联锁）。'],
    [`${id}_valves`]: [`药液槽 ${n} · 阀门`, g, '气动球阀：通压缩空气，上面的执行器把阀杆转 90°，里面的球跟着转到开或关；接液部分是 PFA。供液阀 V1～V3：DIW、药液 1、药液 2，从上方进内槽；排液阀 V4（内槽）、V5（外槽）：换液时打开。顶上的指示器绿色 = 开，灰色 = 关。'],
    [`${id}_pipes`]: [`药液槽 ${n} · 管路`, g, '循环线：外槽 → 泵 → 加热器 → 过滤器 → 内槽底部；供液从上方进内槽；排液到酸 / 碱排液。正在流的管子按液体颜色显示；顶栏"管路图"看 2D 图。'],
    [`${id}_lifter`]: [`药液槽 ${n} · 升降器`, g, '接片、把晶圆浸下去、提上来；带槽的导杆托住 50 片的下边缘。空着时停在下面，要交接时才升上来。'],
    [`${id}_sensors`]: [`药液槽 ${n} · 温度计 / 液位计 / 仪表`, g, '测温探头是 PFA 包覆的铂电阻（Pt100），伸进内槽、上端弯过槽沿；液位计插在外槽里（外槽液位低，泵要停）；前面的仪表实时显示温度。浓度计还没画（阶段 3 做按浓度补液）。'],
  });
}
PART_INFO.cb2_mega = ['药液槽 2 · 兆声振子 + 发生器', '药液槽 2（SC1）', '振子：压电陶瓷贴在振板背面，装在内槽底外侧，外面是不锈钢壳，侧面有电缆接头和冷却用的进出口。发生器（下面的方盒）输出约 1 MHz 的高频电，经电缆送到振子，屏幕显示开 / 关。约 1 MHz 的声波（超声清洗是 20 ~ 200 kHz），空化比超声弱得多、尺度小得多，帮忙把小颗粒冲走；功率太大会伤到细图形。'];
for (const [id, n] of [['ob1', 1], ['ob2', 2]]) {
  const g = `单槽 ${n}`;
  Object.assign(PART_INFO, {
    [`${id}_tank`]: [`单槽 ${n} · 槽体`, g, '石英槽。同一个槽里换液：低浓度药液处理、纯水上流冲洗都在这里做，每批现配、用完排掉。'],
    [`${id}_pan`]: [`单槽 ${n} · 接液槽`, g, '把槽围起来的外槽。两侧的溢流和快排的水都落到这里，再从一根排液管出去，按液体切到酸排液 / 碱排液 / DIW 回收。'],
    [`${id}_inlet`]: [`单槽 ${n} · 槽底进液分配管`, g, 'DIW（和注进去的药）从槽底后角进来，沿两条长边往片间送，从顶部溢流走（上流）。'],
    [`${id}_shower`]: [`单槽 ${n} · 淋浴喷嘴`, g, '槽口两侧各一根管，下面一排小喷嘴斜着往晶圆上喷。快排时喷水，让晶圆保持湿润，防止液面降下去时弯月面把图形拉倒；快排后补水时一直喷到晶圆重新浸没。'],
    [`${id}_mix`]: [`单槽 ${n} · 混合块`, g, '冷 / 热 DIW 汇合后从这里穿过，HF、HCl、NH₄OH、H₂O₂（大 / 小流量两路）的注入阀插在后面，按比例把原液注进去。槽里浓度 = 原液流量 ÷ 总流量；满槽注药时浓度按 1 − e^(−t/τ) 爬升。'],
    [`${id}_fcv`]: [`单槽 ${n} · 流量控制`, g, '冷 DIW、热 DIW 各一个阀，汇合以后经过这里：下面是带浮子的玻璃管流量计（浮子越高流量越大），上面是流量调节阀（侧面旋钮），把进槽的总流量控制在设定值，再进混合块。SPM 之后先用热水冲：硫酸黏、难冲。'],
    [`${id}_valves`]: [`单槽 ${n} · 阀门`, g, '气动球阀：通压缩空气，上面的执行器把阀杆转 90°，里面的球跟着转到开或关；接液部分是 PFA。V1 冷 DIW、V2 热 DIW、V3～V7 注入阀、V8 淋浴、V9 快排（大口径，在槽底侧面）、V10～V12 排液分流（酸 / 碱 / 回收）。顶上的指示器绿色 = 开，灰色 = 关。'],
    [`${id}_pipes`]: [`单槽 ${n} · 管路`, g, '冷 / 热 DIW 先汇合，经流量控制从下往上穿过混合块，从槽底进槽；溢流、快排落进接液槽，再分到酸 / 碱 / 回收（快排不进回收）。正在流的管子按液体颜色显示；顶栏"管路图"看 2D 图。'],
    [`${id}_mega`]: [`单槽 ${n} · 兆声振子 + 发生器`, g, '振子贴在槽底外侧、进液口旁边（压电陶瓷贴在振板背面，外面是不锈钢壳）；发生器在接液槽下面，电缆穿过接液槽底接过去，屏幕显示开 / 关。约 1 MHz，帮忙把小颗粒冲走。这一版的配方在单槽里不开。'],
    [`${id}_res`]: [`单槽 ${n} · 比电阻计 / 测温探头 / 仪表`, g, '都装在槽里（作者确认）。比电阻计是 PFA 护套的长杆，下端是同心的两个电极（中心一根、外面一圈），测两极之间的电阻；测温探头是 PFA 包覆的铂电阻，上端弯过槽沿。前面的仪表实时显示比电阻和温度。25 °C 纯水是 18.18 MΩ·cm，离子越多越低；冲到 ≥ 10 MΩ·cm 以后再溢流 30 s，排水才切到回收。'],
    [`${id}_lifter`]: [`单槽 ${n} · 升降器`, g, '同药液槽的升降器。'],
  });
}
const PARTS = {};
function addPart(id, obj) {
  const info = PART_INFO[id] || [id, '其他', ''];
  if (!PARTS[id]) PARTS[id] = { id, name: info[0], grp: info[1], desc: info[2], objs: [] };
  PARTS[id].objs.push(obj);
  obj.traverse(m => {
    m.userData.part = id;
    if (m.isMesh && m.material && !m.material.userData.shared) { m.material = m.material.clone(); m.material.userData.shared = false; }
  });
  scene.add(obj);
  return obj;
}
function label(text, x, y, z, main = false) {
  const d = document.createElement('div');
  d.className = 'lab' + (main ? ' main' : '');
  d.textContent = text;
  const o = new CSS2DObject(d);
  o.position.set(x, y, z);
  scene.add(o);
  return o;
}

// ================= 地面、机架 =================
const floor = box(10, 0.02, 6, MAT.floor, -0.5, -0.01, 0.2);
floor.receiveShadow = true;
scene.add(floor);
const CAB_X0 = -2.0, CAB_X1 = 1.9, CAB_Y = 0.965, CAB_Z = 0.36;
const frontPanel = box(CAB_X1 - CAB_X0, CAB_Y, 0.01, MAT.glass, (CAB_X0 + CAB_X1) / 2, CAB_Y / 2, CAB_Z);
frontPanel.material.userData.noPick = true;
scene.add(frontPanel);
addPart('frame', group(
  box(CAB_X1 - CAB_X0, 0.06, 0.74, MAT.panel, (CAB_X0 + CAB_X1) / 2, 0.03, 0),               // 底座
  box(0.02, CAB_Y, 0.74, MAT.panel, CAB_X0, CAB_Y / 2, 0), box(0.02, CAB_Y, 0.74, MAT.panel, CAB_X1, CAB_Y / 2, 0),
  box(CAB_X1 - CAB_X0, 0.02, 0.06, MAT.panel, (CAB_X0 + CAB_X1) / 2, CAB_Y, 0.33),            // 台面前沿
  box(CAB_X1 - CAB_X0, 0.02, 0.12, MAT.panel, (CAB_X0 + CAB_X1) / 2, CAB_Y, -0.30),           // 台面后沿
  box(5.4, 1.95, 0.02, MAT.wall, -0.75, 0.975, -0.64),                                       // 后墙
  box(0.04, CAB_Y, 0.04, MAT.steel, CAB_X0, CAB_Y / 2, CAB_Z), box(0.04, CAB_Y, 0.04, MAT.steel, CAB_X1, CAB_Y / 2, CAB_Z),
));
// 台面上各站之间的隔板
const STX = [X.chuck, X.cb1, X.ob1, X.cb2, X.ob2, X.dr];
for (let i = 1; i < STX.length; i++) scene.add(box(0.12, 0.02, 0.48, MAT.panel, (STX[i - 1] + STX[i]) / 2, CAB_Y, 0));
addPart('leak', box(CAB_X1 - CAB_X0 - 0.06, 0.03, 0.6, MAT.resin, (CAB_X0 + CAB_X1) / 2, 0.075, 0));
addPart('exhaust', group(...[X.cb1, X.ob1, X.cb2, X.ob2, X.dr].map(x => box(0.34, 0.025, 0.02, MAT.wall, x, CAB_Y + 0.03, -0.33))));
addPart('ctrl', group(box(0.5, 1.8, 0.6, MAT.panel, 2.25, 0.9, -0.1), box(0.34, 0.24, 0.02, MAT.screen, 2.25, 1.35, 0.205)));
addPart('tower', group(cylY(0.012, 0.25, MAT.steel, 2.25, 1.92, -0.3), cylY(0.035, 0.05, MAT.green, 2.25, 2.06, -0.3), cylY(0.035, 0.05, MAT.amber, 2.25, 2.11, -0.3), cylY(0.035, 0.05, MAT.red, 2.25, 2.16, -0.3)));
const towerLights = PARTS.tower.objs[0].children.slice(1);

// ================= 装载区 =================
addPart('frame', group(box(1.3, 0.9, 0.74, MAT.panel, -2.75, 0.45, 0), box(1.3, 1.1, 0.02, MAT.glass, -2.75, 1.45, 0.37)));
addPart('ffu', box(1.3, 0.12, 0.74, MAT.panel, -2.75, 2.06, 0));
addPart('emo', group(cylZ(0.03, 0.02, MAT.red, -2.2, 0.75, 0.38), box(0.08, 0.08, 0.01, MAT.amber, -2.2, 0.75, 0.372)));
const foupDoor = {};
for (const f of [1, 2]) {
  addPart(`lp${f}`, group(box(0.46, 0.04, 0.42, MAT.steel, FOUP_X[f], 0.92, FOUP_Z), box(0.46, 0.5, 0.03, MAT.panel, FOUP_X[f], 1.15, FOUP_Z - 0.24)));
  const shell = group(
    box(0.39, 0.012, 0.33, MAT.foup, 0, 0.006, 0), box(0.39, 0.012, 0.33, MAT.foup, 0, 0.32, 0),
    box(0.012, 0.32, 0.33, MAT.foup, -0.19, 0.16, 0), box(0.012, 0.32, 0.33, MAT.foup, 0.19, 0.16, 0),
    box(0.39, 0.32, 0.012, MAT.foup, 0, 0.16, 0.165),
  );
  shell.position.set(FOUP_X[f], 0.945, FOUP_Z);
  addPart(`foup${f}`, shell);
  foupDoor[f] = box(0.37, 0.3, 0.02, MAT.foup, FOUP_X[f], 1.105, FOUP_Z - 0.17);
  addPart(`foup${f}`, foupDoor[f]);
}
const mapper = box(0.3, 0.012, 0.03, MAT.dark, FOUP_X[1], FOUP_Y0, FOUP_Z - 0.3);
addPart('mapper', mapper);
const mapper2 = box(0.3, 0.012, 0.03, MAT.dark, FOUP_X[2], FOUP_Y0, FOUP_Z - 0.3);
addPart('mapper', mapper2);
// 批量取片机械手：底座 + 转台 + 叉子
const BR = { x: -2.84, z: 0.18 };
const brYaw = new THREE.Group();
brYaw.position.set(BR.x, 1.0, BR.z);
brYaw.add(box(0.08, 0.06, 0.34, MAT.steel, 0, 0, 0.17), box(0.2, 0.01, 0.12, MAT.chuck, 0, -0.01, 0.36));
addPart('batch_robot', group(cylY(0.09, 0.12, MAT.panel, BR.x, 0.96, BR.z), brYaw));
// 姿态变换单元：底座 + 跟着晶圆转的托架
const postureRot = new THREE.Group();
postureRot.position.copy(PIVOT);
postureRot.add(box(0.012, 0.29, 0.26, MAT.lifter, 0.165, 0, 0), box(0.04, 0.29, 0.02, MAT.lifter, 0.15, 0, -0.12), box(0.04, 0.29, 0.02, MAT.lifter, 0.15, 0, 0.12));
addPart('posture', group(
  box(0.1, Y_HAND - 0.9, 0.1, MAT.panel, PIVOT.x, 0.9 + (Y_HAND - 0.9) / 2, -0.22),     // 立柱
  box(0.12, 0.12, 0.1, MAT.dark, PIVOT.x, PIVOT.y, -0.22),                           // 转动电机（轴沿 Z）
  cylZ(0.02, 0.08, MAT.steel, PIVOT.x, PIVOT.y, -0.14),
  postureRot));

// ================= 导轨和槽间搬送机械手 =================
addPart('rail', group(box(4.6, 0.06, 0.08, MAT.steel, -0.45, 1.70, -0.58), box(4.6, 0.02, 0.02, MAT.dark, -0.45, 1.735, -0.55)));
const robotG = new THREE.Group();
const chuckSide = { 1: new THREE.Group(), [-1]: new THREE.Group() };
{
  robotG.add(box(0.24, 0.2, 0.14, MAT.panel, 0, 1.70, -0.47));
  robotG.add(box(0.07, 0.26, 0.07, MAT.steel, 0, 1.56, -0.47));
  robotG.add(box(0.08, 0.06, 0.5, MAT.steel, 0, 1.50, -0.24));
  robotG.add(box(0.40, 0.04, 0.06, MAT.steel, 0, 1.47, 0));
  for (const s of [1, -1]) {
    const g = chuckSide[s];
    for (const hx of [-0.175, 0.175]) g.add(box(0.012, 0.34, 0.03, MAT.steel, hx, 1.30, 0));
    g.add(cylX(0.008, 0.36, MAT.chuck, 0, Y_HAND - 0.075, 0));
    robotG.add(g);
  }
}
addPart('robot', robotG);

// ================= 夹爪清洗干燥位 =================
{
  const g = group(
    box(0.5, 0.02, 0.48, MAT.resin, 0, CAB_Y + 0.0, 0),
    box(0.48, 0.32, 0.006, MAT.quartz, 0, CAB_Y + 0.16, -0.22), box(0.48, 0.32, 0.006, MAT.quartz, 0, CAB_Y + 0.16, 0.22),
    box(0.006, 0.32, 0.44, MAT.quartz, -0.24, CAB_Y + 0.16, 0), box(0.006, 0.32, 0.44, MAT.quartz, 0.24, CAB_Y + 0.16, 0),
    ...[-0.12, 0, 0.12].flatMap(x => [cylZ(0.008, 0.04, MAT.resin, x, Y_HAND - 0.075, -0.2), cylZ(0.008, 0.04, MAT.resin, x, Y_HAND - 0.075, 0.2)]),
  );
  g.position.x = X.chuck;
  addPart('chuck_clean', g);
}

// ================= 各个槽 =================
const ST = {};
const LIQ = {
  diw: new THREE.Color(0x3d9fe6), hot: new THREE.Color(0xf08a50),
  H2SO4: new THREE.Color(0xd9ae3c), NH3: new THREE.Color(0x7ccf95), HF: new THREE.Color(0xf0a0c6), HCl: new THREE.Color(0xe8d070),
  ipa: new THREE.Color(0xa688e6),
};

// ---------- 管路的三维：按 sim/piping.js 的数据生成 ----------
const PIPE3D = {}, VALVE3D = {};
const FLUID_COL = {
  SPM: 0xd9ae3c, H2SO4: 0xd9ae3c, SC1: 0x7ccf95, NH3: 0x7ccf95, H2O2: 0x9fd6e8, HF: 0xf0a0c6, HCl: 0xc7c35a,
  DIW: 0x3d9fe6, HDIW: 0xf08a50, RA: 0xe8d39a, RK: 0xb3e0c0, gas: 0xb0b8c0,
};
const PIPE_IDLE = 0xebe8de, VALVE_OPEN = 0x2fa36b, VALVE_SHUT = 0x9aa3ab;
const place = (obj, p) => { obj.position.set(...p); return obj; };
// 阀门所在那段管子的方向：上游管的末端 → 下游管的起点
function valveAxis(t, nid) {
  const ein = t.edges.find(e => e.b === nid && e.r3), eout = t.edges.find(e => e.a === nid && e.r3);
  const a = ein ? ein.r3[ein.r3.length - 1] : t.p3[nid], b = eout ? eout.r3[0] : t.p3[nid];
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  return Math.hypot(...d) > 1e-6 ? d : [1, 0, 0];
}
function buildPiping3D(id, x) {
  const t = PIPING.templates.find(tt => tt.id === id);
  const at = p => [x + p[0], p[1], p[2]];
  const out = {};
  for (const nid in t.nodes) {
    const n = t.nodes[nid];
    if (!t.p3[nid]) continue;
    const pos = at(t.p3[nid]), sz = t.size3 && t.size3[nid];
    if (n.kind === 'pump') addPart(`${id}_pump`, place(magPump(), pos));
    else if (n.kind === 'heater') addPart(`${id}_heater`, place(inlineHeater(0.22), pos));
    else if (n.kind === 'filter') addPart(`${id}_filter`, place(filterHousing(0.3), pos));
    else if (n.kind === 'mixer') addPart(`${id}_mix`, place(mixingBlock(...sz), pos));
    else if (n.kind === 'unit') addPart(`${id}_${n.part3 || 'units'}`, place(n.part3 === 'fcv' ? flowControl(sz[1]) : box(...sz, MAT.panel), pos));
    else if (n.kind === 'device') {
      // 兆声振子：贴在槽底外侧，电缆接头朝发生器那边（−X）
      const tr = megaTransducer(sz[0], sz[2], -1);
      addPart(`${id}_mega`, place(tr.g, [pos[0], pos[1] + sz[1] / 2, pos[2]]));
      out.megaPort = [pos[0] + tr.port[0], pos[1] + sz[1] / 2 + tr.port[1], pos[2] + tr.port[2]];
    }
    else if (n.kind === 'junction') addPart(`${id}_pipes`, mesh(new THREE.SphereGeometry(0.017, 12, 8), MAT.resin, ...pos));
    else if (n.kind === 'valve') {
      // 气动球阀：阀体顺着管子；执行器默认朝上，竖管上的阀朝前（act3: 'z'），免得顶到上面的管子
      const v = ballValve(n.big ? 0.06 : 0.04, valveAxis(t, nid), (t.act3 && t.act3[nid]) === 'z' ? [0, 0, 1] : [0, 1, 0]);
      addPart(`${id}_valves`, place(v.g, pos));
      VALVE3D[nid] = v.ind;
    }
  }
  const big = nid => t.nodes[nid] && t.nodes[nid].big;
  for (const e of t.edges) {
    if (!e.r3) continue;
    const m = pipe(e.r3.map(at), big(e.a) || big(e.b) ? 0.02 : e.sys === 'supply' ? 0.008 : 0.012, MAT.resin);
    addPart(`${id}_pipes`, m);
    PIPE3D[e.id] = m;
  }
  // 进槽的接口、接到后墙的法兰、排液总管
  for (const e of t.edges) if (e.r3 && e.sys === 'supply' && PIPING.nodes[e.b].kind === 'tank') { const p = at(e.r3[e.r3.length - 1]); addPart(`${id}_pipes`, cylY(0.012, 0.03, MAT.resin, p[0], p[1] - 0.01, p[2])); }
  for (const e of t.edges) if (e.r3 && e.a.startsWith('src.')) { const p = at(e.r3[0]); addPart(`${id}_pipes`, cylZ(0.02, 0.012, MAT.steel, p[0], p[1], p[2])); }
  for (const [hy, hz, len] of t.hdr3) addPart(`${id}_pipes`, cylX(0.016, len, MAT.resin, x, hy, hz));
  return out;
}
function updatePiping3D(pip) {
  for (const eid in PIPE3D) PIPE3D[eid].material.color.setHex(pip.flows[eid] ? FLUID_COL[pip.flows[eid]] : PIPE_IDLE);
  for (const vid in VALVE3D) VALVE3D[vid].material.color.setHex(pip.state.open[vid] ? VALVE_OPEN : VALVE_SHUT);
  // 仪表、发生器的屏幕（只在读数变了时重画）
  for (const id of ['ob1', 'ob2']) { ST[id].meter.lcd.set([`${fmtRho(L[id].rho)} MΩ·cm`, `${L[id].T.toFixed(1)} °C`]); ST[id].gen.set(['兆声 OFF', '']); }
  for (const id of ['cb1', 'cb2']) ST[id].meter.lcd.set([`${L[id].T.toFixed(1)} °C`, `设定 ${L[id].Tset} °C`]);
  ST.cb2.gen.set(L.cb2.mega ? ['兆声 ON', `${Math.round(L.cb2.megaP * 100)} %  1 MHz`] : ['兆声 OFF', '']);
  // 单槽：接液槽底有液体在走、两侧溢流的水膜
  for (const id of ['ob1', 'ob2']) {
    const s = ST[id], t = PIPING.templates.find(tt => tt.id === id);
    const f = t.edges.filter(e => e.b === `${id}.PAN`).map(e => pip.flows[e.id]).find(Boolean);
    s.panLiq.scale.y = f ? 0.015 : 0.001;
    if (f) s.panLiq.material.color.setHex(FLUID_COL[f]);
    const ov = pip.flows[`${id}.TANK>${id}.PAN#L`];
    for (const sh of s.sheets) { sh.visible = !!ov; if (ov) sh.material.color.setHex(FLUID_COL[ov]); }
  }
}

function makeLifter(id, x) {
  const g = new THREE.Group();
  g.add(cylX(0.006, 0.30, MAT.lifter, 0, -0.156, 0));
  g.add(cylX(0.006, 0.30, MAT.lifter, 0, -0.12, 0.10));
  g.add(cylX(0.006, 0.30, MAT.lifter, 0, -0.12, -0.10));
  g.add(box(0.31, 0.05, 0.008, MAT.lifter, 0, -0.13, -0.163));
  g.add(box(0.03, 0.35, 0.012, MAT.lifter, 0, 0.045, -0.165));
  g.add(box(0.06, 0.03, 0.03, MAT.dark, 0, 0.21, -0.16));
  g.position.set(x, Y_DOWN, 0);
  addPart(`${id}_lifter`, g);
  return g;
}

const MX = 0.29;   // 槽旁边仪表的 X 偏移（两个槽之间的空当）
function buildChemBath(id, x, kind) {
  const s = ST[id] = { x };
  const t = quartzTank(IL, IW, IH);
  t.position.set(x, Y_BOTTOM, 0);
  addPart(`${id}_inner`, t);
  // 外槽：槽口外面一圈
  const ow = 0.055, od = 0.14, y0 = Y_TOP - od;
  const outer = group(
    box(IL + 2 * ow + 0.012, 0.006, ow, MAT.quartz, 0, y0, IW / 2 + ow / 2 + 0.006), box(IL + 2 * ow + 0.012, 0.006, ow, MAT.quartz, 0, y0, -IW / 2 - ow / 2 - 0.006),
    box(ow, 0.006, IW, MAT.quartz, IL / 2 + ow / 2 + 0.006, y0, 0), box(ow, 0.006, IW, MAT.quartz, -IL / 2 - ow / 2 - 0.006, y0, 0),
    box(IL + 2 * ow + 0.024, od, 0.006, MAT.quartz, 0, y0 + od / 2, IW / 2 + ow + 0.009), box(IL + 2 * ow + 0.024, od, 0.006, MAT.quartz, 0, y0 + od / 2, -IW / 2 - ow - 0.009),
    box(0.006, od, IW + 2 * ow + 0.024, MAT.quartz, IL / 2 + ow + 0.009, y0 + od / 2, 0), box(0.006, od, IW + 2 * ow + 0.024, MAT.quartz, -IL / 2 - ow - 0.009, y0 + od / 2, 0),
  );
  outer.position.x = x;
  addPart(`${id}_outer`, outer);
  const color = kind === 'SPM' ? LIQ.H2SO4 : LIQ.NH3;
  s.liquid = liquidBox(IL - 0.004, IW - 0.004, color, 0.32);
  s.liquid.position.set(x, Y_BOTTOM, 0);
  s.liquid.scale.y = IH;
  scene.add(s.liquid);
  s.outerLiq = liquidBox(IL + 2 * ow, IW + 2 * ow, color, 0.3);
  s.outerLiq.position.set(x, y0 + 0.003, 0);
  s.outerLiq.scale.y = 0.05;
  scene.add(s.outerLiq);
  // 循环线、供液、排液：按 sim/piping.js 的同一份数据生成（和 2D 管路图一致）
  buildPiping3D(id, x);
  // 测温探头伸进内槽前右角、弯过槽沿；液位计插在外槽里；前面的仪表显示温度
  const rtd = rtdProbe(0.28, 0.1);
  addPart(`${id}_sensors`, place(rtd.g, [x + IL / 2 - 0.02, Y_TOP + 0.02, IW / 2 - 0.02]));
  addPart(`${id}_sensors`, place(levelProbe(0.1), [x - IL / 2 - 0.028, Y_TOP + 0.03, IW / 2 - 0.03]));
  s.meter = meter();
  addPart(`${id}_sensors`, place(s.meter.g, [x + MX, CAB_Y, 0.29]));      // 放在两个槽之间的前面，不挡槽里
  addPart(`${id}_sensors`, cable([[x + IL / 2 - 0.02, Y_TOP - 0.003, IW / 2 + 0.095], [x + IL / 2 - 0.02, CAB_Y, IW / 2 + 0.095]]));
  if (kind === 'SC1') {
    // 兆声：振子贴在内槽底外侧，电缆接到下面的发生器
    const tr = megaTransducer(0.3, 0.3, -1);
    addPart(`${id}_mega`, place(tr.g, [x, Y_BOTTOM - 0.007, 0]));
    const gen = megaGenerator(0.14, 0.12, 0.12);
    addPart(`${id}_mega`, place(gen.g, [x - 0.15, 0.45, -0.15]));
    s.gen = gen.lcd;
    const pt = [x + tr.port[0], Y_BOTTOM - 0.007 + tr.port[1], 0];
    addPart(`${id}_mega`, cable([pt, [x - 0.19, pt[1], 0], [x - 0.19, 0.53, 0], [x - 0.19, 0.53, -0.15], [x - 0.19, 0.51, -0.15]]));
    s.rings = [0, 1, 2].map(i => {
      const r = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.1, 40), see(0xffffff, 0.0));
      r.rotation.x = -Math.PI / 2;
      r.position.set(x, Y_BOTTOM + 0.02, 0);
      r.userData.phase = i / 3;
      r.material.userData.noPick = true;
      scene.add(r);
      return r;
    });
  }
  s.lifter = makeLifter(id, x);
  s.bubbles = makePoints(110, 0xffffff, 0.006, 0.55);
}

// 单槽的接液槽：把槽围起来（作者的概要图），两侧溢流和快排都落到这里
const PAN_L = 0.50, PAN_W = 0.41, PAN_Y = 0.50, PAN_H = 0.45;
function buildOneBath(id, x) {
  const s = ST[id] = { x };
  const t = quartzTank(IL, IW, IH);
  t.position.set(x, Y_BOTTOM, 0);
  addPart(`${id}_tank`, t);
  const pan = quartzTank(PAN_L, PAN_W, PAN_H);
  pan.position.set(x, PAN_Y, 0);
  addPart(`${id}_pan`, pan);
  s.liquid = liquidBox(IL - 0.004, IW - 0.004, LIQ.diw, 0.3);
  s.liquid.position.set(x, Y_BOTTOM, 0);
  scene.add(s.liquid);
  s.panLiq = liquidBox(PAN_L - 0.004, PAN_W - 0.004, LIQ.diw, 0.4);
  s.panLiq.position.set(x, PAN_Y, 0);
  scene.add(s.panLiq);
  // 两侧溢流：越过槽口、顺着槽外壁流下去的水膜（示意）
  s.sheets = [-1, 1].map(side => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(IW - 0.02, 0.3), see(0x3d9fe6, 0.28));
    m.rotation.y = Math.PI / 2;
    m.position.set(x + side * (IL / 2 + 0.012), Y_TOP - 0.15, 0);
    m.material.userData.noPick = true;
    m.visible = false;
    scene.add(m);
    return m;
  });
  // 槽底进液分配管：进液口在槽底后角，沿两条长边往片间送液
  addPart(`${id}_inlet`, group(cylX(0.009, 0.3, MAT.resin, x, Y_BOTTOM + 0.012, -0.155), cylX(0.009, 0.3, MAT.resin, x, Y_BOTTOM + 0.012, 0.155), cylZ(0.009, 0.31, MAT.resin, x - 0.15, Y_BOTTOM + 0.012, 0)));
  addPart(`${id}_shower`, group(cylX(0.009, 0.34, MAT.resin, x, Y_TOP + 0.07, IW / 2 + 0.03), cylX(0.009, 0.34, MAT.resin, x, Y_TOP + 0.07, -IW / 2 - 0.03),
    cylZ(0.009, IW + 0.06, MAT.resin, x - 0.17, Y_TOP + 0.07, 0),
    place(nozzleRow(7, 0.045, -1), [x, Y_TOP + 0.07, IW / 2 + 0.03]), place(nozzleRow(7, 0.045, 1), [x, Y_TOP + 0.07, -IW / 2 - 0.03])));
  // 比电阻计、测温探头都在槽里（作者确认）；前面的仪表显示比电阻和温度
  const res = resistivityProbe(0.34);
  addPart(`${id}_res`, place(res.g, [x + IL / 2 - 0.02, Y_TOP + 0.085, IW / 2 - 0.02]));
  const rtd = rtdProbe(0.26, 0.1);
  addPart(`${id}_res`, place(rtd.g, [x - IL / 2 + 0.02, Y_TOP + 0.02, IW / 2 - 0.02]));
  s.meter = meter();
  addPart(`${id}_res`, place(s.meter.g, [x + MX, CAB_Y, 0.29]));
  const rp = [x + IL / 2 - 0.02 + res.cablePort[0], Y_TOP + 0.085 + res.cablePort[1], IW / 2 - 0.02];
  addPart(`${id}_res`, cable([rp, [x + MX + 0.0224, rp[1], rp[2]], [x + MX + 0.0224, rp[1], 0.276]]));     // 接到仪表背面
  addPart(`${id}_res`, cable([[x - IL / 2 + 0.02, Y_TOP - 0.003, IW / 2 + 0.095], [x - IL / 2 + 0.02, CAB_Y, IW / 2 + 0.095]]));
  // 冷 / 热 DIW、注药、淋浴、快排、排液分流、兆声振子：按 sim/piping.js 的同一份数据生成（和 2D 管路图一致）
  const pp = buildPiping3D(id, x);
  // 兆声发生器在接液槽下面，电缆穿过接液槽底接到振子
  const gen = megaGenerator(0.1, 0.08, 0.1);
  addPart(`${id}_mega`, place(gen.g, [x - 0.2, 0.42, 0.12]));
  s.gen = gen.lcd;
  if (pp.megaPort) addPart(`${id}_mega`, cable([pp.megaPort, [x - 0.175, pp.megaPort[1], 0], [x - 0.175, 0.44, 0], [x - 0.175, 0.44, 0.07]]));
  s.lifter = makeLifter(id, x);
  s.bubbles = makePoints(130, 0xffffff, 0.006, 0.6);
  s.shower = makePoints(120, 0x9fd8ff, 0.007, 0.8);
}

function buildDryer(id, x) {
  const s = ST[id] = { x };
  const t = quartzTank(IL, IW, IH);
  t.position.set(x, Y_BOTTOM, 0);
  addPart('dr_tank', t);
  // 上面的密封空间（晶圆提上来后在这里干燥）
  const up = quartzTank(0.44, 0.46, 0.42);
  up.children[0].visible = false;
  up.position.set(x, Y_TOP, 0);
  addPart('dr_tank', up);
  s.liquid = liquidBox(IL - 0.004, IW - 0.004, LIQ.diw, 0.24);
  s.liquid.position.set(x, Y_BOTTOM, 0);
  s.liquid.scale.y = IH;
  scene.add(s.liquid);
  s.ipa = liquidBox(IL - 0.004, IW - 0.004, LIQ.ipa, 0.0);
  s.ipa.position.set(x, Y_TOP - 0.012, 0);
  s.ipa.scale.y = 0.014;
  scene.add(s.ipa);
  s.lid = box(0.48, 0.03, 0.5, MAT.panel, x, Y_TOP + 0.45, 0);
  addPart('dr_lid', s.lid);
  addPart('dr_ipa', group(cylX(0.008, 0.36, MAT.resin, x, Y_TOP + 0.03, 0.2), cylX(0.008, 0.36, MAT.resin, x, Y_TOP + 0.03, -0.2)));
  addPart('dr_n2', group(cylX(0.008, 0.36, MAT.steel, x, Y_TOP + 0.38, 0.2), cylX(0.008, 0.36, MAT.steel, x, Y_TOP + 0.38, -0.2)));
  addPart('dr_vac', group(cylY(0.08, 0.2, MAT.pump, x + 0.1, 0.2, -0.1), pipe([[x + 0.1, 0.3, -0.1], [x + 0.1, 0.6, -0.3], [x + 0.1, Y_TOP + 0.25, -0.3], [x + 0.1, Y_TOP + 0.25, -0.23]], 0.025, MAT.steel)));
  s.lifter = makeLifter('dr', x);
  s.vapor = makePoints(90, 0xb9a2f0, 0.008, 0.5);
}

// ---------- 粒子（示意） ----------
const effects = [];
function makePoints(n, color, size, opacity) {
  const pos = new Float32Array(n * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity, depthWrite: false });
  mat.userData.noPick = true;
  const p = new THREE.Points(geo, mat);
  p.frustumCulled = false;
  p.visible = false;
  p.userData.seed = Array.from({ length: n }, () => [Math.random(), Math.random(), Math.random()]);
  scene.add(p);
  effects.push(p);
  return p;
}

buildChemBath('cb1', X.cb1, 'SPM');
buildOneBath('ob1', X.ob1);
buildChemBath('cb2', X.cb2, 'SC1');
buildOneBath('ob2', X.ob2);
buildDryer('dr', X.dr);
const chuckSpray = makePoints(90, 0xa6dcff, 0.006, 0.8);

// 标签
const LABELS = [
  label('装载区', -2.75, 1.62, 0.3),
  label('夹爪清洗干燥位', X.chuck, 1.42, 0.25),
  label('药液槽 1 · SPM', X.cb1, 1.06, 0.3, true),
  label('单槽 1', X.ob1, 1.06, 0.3, true),
  label('药液槽 2 · SC1', X.cb2, 1.06, 0.3, true),
  label('单槽 2', X.ob2, 1.06, 0.3, true),
  label('减压干燥槽', X.dr, 1.5, 0.3, true),
];

// ---------- 晶圆：50 片用一个 InstancedMesh ----------
const waferGeo = new THREE.CylinderGeometry(P.waferD / 2, P.waferD / 2, 0.0016, 48);   // 厚度放大 2 倍，看得见
const waferMesh = new THREE.InstancedMesh(waferGeo, MAT.wafer, P.nWafer);
waferMesh.castShadow = true;
waferMesh.frustumCulled = false;   // 包围球只在第一次渲染时算一次，晶圆移走后会被误剔除
scene.add(waferMesh);
const dummy = new THREE.Object3D();
const Q_H = new THREE.Quaternion();
const Q_V = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);

if (has3D && !LOW) scene.traverse(o => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });

// ================= 模拟 =================
let R = cloneRecipe(DEFAULT);      // 配方：流程 → 单元 → 步骤（sim/recipe.js）
let L = new Line(R);
let speed = 60, paused = false;
const SIM_DT = 0.1;

// ================= 每帧更新三维 =================
const tmpC = new THREE.Color();
function obColor(ob, out) {
  out.copy(LIQ.diw);
  out.lerp(LIQ.hot, clamp((ob.T - 25) / 50, 0, 1) * 0.75);
  const sp = ob.mainSpecies();
  let f = 0;
  if (sp && sp !== 'H2O2') {
    f = clamp(Math.log10(ob.c[sp] / 1e-6) / Math.log10(0.3 / 1e-6), 0, 1);
    out.lerp(LIQ[sp], f);
  }
  return f;
}

function waferPose(b, out) {
  const f = 1 + (b % 2), slot = Math.floor(b / 2);
  const k = b - (P.nWafer - 1) / 2;
  const h = L.batch.holder;
  const foupPos = () => out.set(FOUP_X[f], FOUP_Y0 + slot * P.foupPitch, FOUP_Z);
  if (h === 'foup') { foupPos(); return Q_H; }
  if (h === 'pick') {
    const e = ease(f === 1 ? L.loader.pick1 : L.loader.pick2);
    const ax = FOUP_X[f], ay = FOUP_Y0 + slot * P.foupPitch, az = FOUP_Z;
    const bx = PIVOT.x, by = PIVOT.y + k * P.pitch, bz = 0;
    out.set(lerp(ax, bx, e), lerp(ay, by, e) + Math.sin(Math.PI * e) * 0.06, lerp(az, bz, e));
    return Q_H;
  }
  if (h === 'posture') {
    const th = -Math.PI / 2 * ease(L.loader.posture);
    const ly = k * P.pitch;
    out.set(PIVOT.x - ly * Math.sin(th), PIVOT.y + ly * Math.cos(th), 0);
    dummy.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), th);
    return dummy.quaternion.clone();
  }
  if (h === 'robot') { out.set(L.robot.x + k * P.pitch, Y_HAND, 0); return Q_V; }
  out.set(X[h] + k * P.pitch, waferY(L.lift[h]), 0);
  return Q_V;
}

const vp = new THREE.Vector3();
function visualsTick(dtR) {
  // 晶圆
  for (let b = 0; b < P.nWafer; b++) {
    const q = waferPose(b, vp);
    dummy.position.copy(vp);
    dummy.quaternion.copy(q);
    dummy.updateMatrix();
    waferMesh.setMatrixAt(b, dummy.matrix);
  }
  waferMesh.instanceMatrix.needsUpdate = true;
  // 机械手
  robotG.position.x = L.robot.x;
  for (const s of [1, -1]) chuckSide[s].position.z = s * (0.137 + 0.063 * L.robot.chuck);
  // 升降器
  for (const id of TANKS) ST[id].lifter.position.y = waferY(L.lift[id]);
  // 装载区
  for (const f of [1, 2]) { foupDoor[f].position.z = FOUP_Z - 0.17 - 0.06 * L.loader.door; foupDoor[f].position.y = 1.105 - 0.3 * L.loader.door; }
  const mapY = FOUP_Y0 + 0.25 * (L.loader.map > 0 && L.loader.map < 1 ? L.loader.map : 0);
  mapper.position.y = mapY; mapper2.position.y = mapY;
  postureRot.rotation.z = -Math.PI / 2 * ease(L.loader.posture);
  const activeF = L.loader.pick1 > 0 && L.loader.pick1 < 1 ? 1 : L.loader.pick2 > 0 && L.loader.pick2 < 1 ? 2 : 0;
  const yawTo = (x, z) => Math.atan2(x - BR.x, z - BR.z);
  const yF = activeF ? yawTo(FOUP_X[activeF], FOUP_Z) : yawTo(PIVOT.x, 0);
  const pe = activeF ? (activeF === 1 ? L.loader.pick1 : L.loader.pick2) : 1;
  brYaw.rotation.y = lerp(yF, yawTo(PIVOT.x, 0), ease(pe));
  // 液体
  for (const id of ['ob1', 'ob2']) {
    const ob = L[id], s = ST[id];
    s.liquid.scale.y = Math.max(0.002, ob.level * IH);
    const f = obColor(ob, tmpC);
    s.liquid.material.color.copy(tmpC);
    s.liquid.material.opacity = 0.3 + 0.15 * f;
  }
  for (const id of ['cb1', 'cb2']) {
    const tc = clamp((L[id].T - 25) / 120, 0, 1);
    ST[id].liquid.material.color.copy(id === 'cb1' ? LIQ.H2SO4 : LIQ.NH3).lerp(LIQ.hot, tc * 0.25);
  }
  const d = L.dr, sd = ST.dr;
  sd.ipa.material.opacity = 0.55 * d.ipa;
  sd.lid.position.y = Y_TOP + 0.45 + (1 - d.lid) * 0.42;     // 打开时升到机械手手臂上面
  // 信号灯
  const run = L.busy, wait = L.stepIdx >= 0 && !L.done && !L.busy;
  towerLights[0].material.emissive.setHex(run ? 0x2fbf5f : 0x000000);
  towerLights[1].material.emissive.setHex(wait ? 0xe0a32e : 0x000000);
  effectsTick(dtR);
}

// 粒子动画（示意，数量和速度不是真实比例）
let effT = 0;
function effectsTick(dtR) {
  effT += dtR;
  const setP = (p, i, x, y, z) => { const a = p.geometry.attributes.position.array; a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z; };
  // 上流的小气泡 / 示踪点
  for (const id of ['ob1', 'ob2', 'cb1', 'cb2']) {
    const s = ST[id], p = s.bubbles;
    const cb = id[0] === 'c';
    const on = cb || (L[id].supplying && L[id].level > 0.97);
    p.visible = on;
    if (!on) continue;
    const top = cb ? IH : L[id].level * IH;
    const v = cb ? 0.05 : 0.04 + L[id].Q / 600;
    p.userData.seed.forEach((sd, i) => {
      const y = ((sd[1] + effT * v / top * (0.6 + sd[2])) % 1) * top;
      setP(p, i, s.x + (sd[0] - 0.5) * (IL - 0.03), Y_BOTTOM + y, (sd[2] - 0.5) * (IW - 0.03));
    });
    p.geometry.attributes.position.needsUpdate = true;
  }
  // 淋浴
  for (const id of ['ob1', 'ob2']) {
    const s = ST[id], p = s.shower, ob = L[id];
    p.visible = ob.showerActive;
    if (!p.visible) continue;
    const surf = Y_BOTTOM + ob.level * IH;
    p.userData.seed.forEach((sd, i) => {
      const side = sd[2] < 0.5 ? 1 : -1, ph = (sd[1] + effT * 2.2) % 1;
      const y = lerp(Y_TOP + 0.065, surf, ph);
      setP(p, i, s.x + (sd[0] - 0.5) * 0.32, y, side * lerp(IW / 2 + 0.03, 0.02 + 0.13 * sd[2], ph));
    });
    p.geometry.attributes.position.needsUpdate = true;
  }
  // 兆声波纹
  const rings = ST.cb2.rings;
  for (const r of rings) {
    const on = L.cb2.mega;
    const ph = (r.userData.phase + effT * 0.6) % 1;
    r.position.y = Y_BOTTOM + 0.02 + ph * (IH - 0.04);
    r.scale.setScalar(1 + ph * 1.2);
    r.material.opacity = on ? 0.45 * (1 - ph) : 0;
  }
  // 夹爪清洗：冲洗时喷水，吹干时是快速的 N₂ 气流
  chuckSpray.visible = !!L.chuckSt;
  if (L.chuckSt) {
    const wash = L.chuckSt === 'wash';
    chuckSpray.material.color.setHex(wash ? 0x8fd0ff : 0xe8eef2);
    chuckSpray.userData.seed.forEach((sd, i) => {
      const side = sd[2] < 0.5 ? 1 : -1, ph = (sd[1] + effT * (wash ? 1.5 : 4)) % 1;
      setP(chuckSpray, i, X.chuck + (sd[0] - 0.5) * 0.36, Y_HAND - 0.075 + (sd[2] - 0.5) * 0.08, side * lerp(0.19, 0.12, ph));
    });
    chuckSpray.geometry.attributes.position.needsUpdate = true;
  }
  // 干燥槽里的 IPA 蒸气 / N₂
  const vp2 = ST.dr.vapor, d = L.dr;
  vp2.visible = d.lid > 0.9 && (d.ipaOn || d.n2On);
  if (vp2.visible) {
    vp2.material.color.setHex(d.ipaOn ? 0xb9a2f0 : 0xe8eef2);
    vp2.material.opacity = d.ipaOn ? 0.55 : 0.3;
    vp2.userData.seed.forEach((sd, i) => {
      const y = Y_TOP + 0.02 + ((sd[1] + effT * 0.05 * (0.5 + sd[2])) % 1) * 0.38;
      setP(vp2, i, X.dr + (sd[0] - 0.5) * 0.4, y, (sd[2] - 0.5) * 0.42);
    });
    vp2.geometry.attributes.position.needsUpdate = true;
  }
}

// ================= 镜头 =================
// 左下角有面板，镜头目标往左下偏一点，让要看的东西落在画面右上
const VIEWS = {
  overview: { p: [-0.75, 3.7, 6.3], t: [-0.95, 0.45, 0] },
  loader: { p: [-1.75, 2.4, 3.0], t: [-2.95, 0.8, 0.15] },
  chuck: { p: [-1.2, 1.95, 1.8], t: [X.chuck - 0.22, 0.95, 0.1] },
};
// 槽的镜头压低一点，隔着透明的机柜前板也能看到槽里的液位
for (const id of TANKS) VIEWS[id] = { p: [X[id] + 0.42, 1.55, 1.95], t: [X[id] - 0.2, 0.72, 0.1] };
let camAnim = null;
function camTo(name) {
  const v = VIEWS[name];
  if (!v) return;
  const t1 = new THREE.Vector3(...v.t), p1 = new THREE.Vector3(...v.p);
  if (camera.aspect < 1) p1.sub(t1).multiplyScalar(1 + 0.9 * (1 - camera.aspect)).add(t1);
  camAnim = { p0: camera.position.clone(), t0: controls.target.clone(), p1, t1, k: 0 };
  document.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.v === name));
}
const follow = () => $('#follow').checked;
let lastFocus = null;
function followBatch() {
  if (!follow() || !L.busy) return;
  const h = L.batch.holder;
  const f = TANKS.includes(h) ? h : (h === 'foup' || h === 'pick' || h === 'posture') ? 'loader' : null;
  if (f && f !== lastFocus) { lastFocus = f; camTo(f); }
}

// ================= 面板：整条线 =================
function fitCanvas(c) {
  const dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  return [w, h];
}
const css = () => getComputedStyle(document.documentElement);
const fontFam = () => getComputedStyle(document.body).fontFamily;
const hex = c => '#' + c.getHexString();
const STN = ['loader', 'chuck', 'cb1', 'ob1', 'cb2', 'ob2', 'dr'];
function drawLine() {
  const c = $('#linec'), [w, h] = fitCanvas(c), g = c.getContext('2d'), cs = css();
  const fg = cs.getPropertyValue('--fg'), muted = cs.getPropertyValue('--muted'), line = cs.getPropertyValue('--line'), acc = cs.getPropertyValue('--accent'), bad = cs.getPropertyValue('--bad');
  g.clearRect(0, 0, w, h);
  const x0 = -3.1, x1 = X.dr + 0.3;
  const sx = x => 8 + (x - x0) / (x1 - x0) * (w - 16);
  const stX = id => (id === 'loader' ? -2.75 : X[id]);
  g.font = '11px ' + fontFam();
  g.textAlign = 'center';
  const top = 26, bh = 42;
  for (const id of STN) {
    const cx = sx(stX(id)), bw = id === 'loader' ? 64 : 52;
    const here = L.batch.holder === id || (id === 'loader' && ['foup', 'pick', 'posture'].includes(L.batch.holder));
    g.strokeStyle = here ? acc : line; g.lineWidth = here ? 2 : 1;
    g.fillStyle = id.startsWith('cb') ? 'rgba(217,174,60,.13)' : id.startsWith('ob') ? 'rgba(99,189,240,.13)' : id === 'dr' ? 'rgba(166,136,230,.13)' : 'rgba(128,128,128,.08)';
    g.beginPath();
    if (g.roundRect) g.roundRect(cx - bw / 2, top, bw, bh, 5); else g.rect(cx - bw / 2, top, bw, bh);
    g.fill(); g.stroke();
    g.fillStyle = fg;
    g.fillText(id === 'loader' ? '装载区' : id === 'chuck' ? '夹爪清洗' : STATION_NAME[id].replace('减压', ''), cx, top + 13);
    g.fillStyle = muted;
    let sub = '';
    if (id === 'loader') sub = L.batch.holder === 'foup' ? (L.done ? '已回盒' : 'FOUP × 2') : '合批';
    else if (id === 'chuck') sub = L.chuckSt === 'wash' ? '冲洗中' : L.chuckSt === 'dry' ? 'N₂ 吹干' : '';
    else if (id.startsWith('cb')) sub = `${L[id].T.toFixed(0)} °C${L[id].mega ? ' 兆声' : ''}`;
    else if (id.startsWith('ob')) sub = `ρ ${fmtRho(L[id].rho)}`;
    else sub = L.dr.ipaOn ? 'IPA' : L.dr.vacOn ? `${L.dr.pressure.toFixed(0)} kPa` : `O₂ ${L.dr.o2.toFixed(1)}%`;
    g.fillText(sub, cx, top + 27);
    if (id.startsWith('ob') && L[id].level < 0.99) { g.fillText(`液位 ${(L[id].level * 100).toFixed(0)}%`, cx, top + 39); }
  }
  // 机械手
  const rx = sx(L.robot.x);
  g.fillStyle = muted;
  g.beginPath(); g.moveTo(rx - 6, 6); g.lineTo(rx + 6, 6); g.lineTo(rx, 14); g.closePath(); g.fill();
  g.textAlign = 'left';
  g.fillText(L.robot.task && L.robot.task !== '待机' ? L.robot.task : '机械手', clamp(rx + 9, 0, w - 120), 13);
  // 晶圆位置
  let bx = null;
  const hd = L.batch.holder;
  if (hd === 'robot') bx = rx; else if (TANKS.includes(hd)) bx = sx(X[hd]); else bx = sx(-2.75);
  g.fillStyle = acc;
  g.beginPath(); g.arc(bx, top + bh + 10, 5, 0, Math.PI * 2); g.fill();
  if (L.air.active) {
    g.fillStyle = L.air.t > 20 ? bad : fg;
    g.fillText(`空气中 ${L.air.t.toFixed(1)} s`, clamp(bx + 9, 0, w - 90), top + bh + 14);
  }
  $('#lineInfo').textContent = `晶圆在：${hd === 'robot' ? '机械手上' : TANKS.includes(hd) ? STATION_NAME[hd] : '装载区'}`;
}
const fmtRho = r => (r >= 1 ? r.toFixed(1) : r >= 0.01 ? r.toFixed(2) : r.toExponential(0)) + '';

// ================= 面板：图形放大 =================
function currentLiquid() {
  const { tank, inLiq } = L.wafersIn();
  const s = L.surf;
  if (L.dried || (s.dry && !L.wetted)) return null;
  if (L.drying && tank === 'dr') {
    const xIpa = L.dr.ipa;
    return { gamma: gammaMix(xIpa), color: LIQ.diw.clone().lerp(LIQ.ipa, Math.pow(xIpa, 0.5)), name: xIpa > 0.05 ? `IPA + 水` : '水', full: L.lift.dr < 0.5 };
  }
  if (inLiq) {
    if (tank === 'cb1') return { gamma: SURF.gammaWater * 0.85, color: LIQ.H2SO4, name: 'SPM', full: true };
    if (tank === 'cb2') return { gamma: SURF.gammaWater * 0.9, color: LIQ.NH3, name: 'SC1', full: true };
    if (tank === 'dr') return { gamma: SURF.gammaWater, color: LIQ.diw, name: '水', full: true };
    const col = new THREE.Color(); obColor(L[tank], col);
    return { gamma: SURF.gammaWater, color: col, name: L[tank].mainSpecies() === 'HF' && L[tank].c.HF > 1e-4 ? 'DHF' : '水', full: true };
  }
  return { gamma: SURF.gammaWater, color: LIQ.diw, name: '液膜', full: false };
}
const PILLAR_T = [0.12, 0.3, 0.5, 0.7, 0.9];
function drawPattern() {
  const c = $('#pat'), [w, h] = fitCanvas(c), g = c.getContext('2d');
  const s = L.surf, liq = currentLiquid();
  g.fillStyle = '#1a2230'; g.fillRect(0, 0, w, h);
  const base = h - 62, ph = 92, pw = 18, gap = 26, n = 5;
  const x0 = (w - (n * pw + (n - 1) * gap)) / 2;
  // 液体
  if (liq) {
    g.fillStyle = hex(liq.color);
    g.globalAlpha = 0.45;
    if (liq.full) g.fillRect(0, 18, w, base - 18);
    else { g.fillRect(0, base - ph * 0.55, w, ph * 0.55); }
    g.globalAlpha = 1;
  }
  // 衬底
  g.fillStyle = '#6b7487'; g.fillRect(0, base, w, h - base - 18);
  // 有机物层、氧化膜
  const ox = Math.min(10, s.chemOx * 5), org = s.org > 0.01 ? Math.min(8, 2 + s.org * 6) : 0;
  if (ox > 0.3) { g.fillStyle = '#9fb8e8'; g.fillRect(0, base - ox, w, ox); }
  if (org) { g.fillStyle = '#8a5a2b'; g.fillRect(0, base - ox - org, w, org); }
  // 线条（倒的画成歪的）
  for (let i = 0; i < n; i++) {
    const x = x0 + i * (pw + gap);
    const down = s.collapse > PILLAR_T[i] - 0.11;
    const tilt = down ? (i % 2 ? -1 : 1) * 0.22 : 0;
    g.save();
    g.translate(x + pw / 2, base - ox - org);
    g.rotate(tilt);
    g.fillStyle = down ? '#c97b7b' : '#b9c2d3';
    g.fillRect(-pw / 2, -ph, pw, ph);
    if (ox > 0.3) { g.strokeStyle = '#9fb8e8'; g.lineWidth = Math.min(3, ox / 2); g.strokeRect(-pw / 2, -ph, pw, ph); }
    g.restore();
  }
  // 颗粒、金属
  const np = Math.min(14, Math.round(s.particles / 35));
  g.fillStyle = '#f2d16b';
  for (let i = 0; i < np; i++) { const x = ((i * 53) % (w - 10)) + 5; g.beginPath(); g.arc(x, base - ox - org - 4, 3.2, 0, Math.PI * 2); g.fill(); }
  const nm = clamp(Math.round(Math.log10(Math.max(s.fe, 1e8) / 1e9) * 4), 0, 12);
  g.fillStyle = '#ff6060';
  for (let i = 0; i < nm; i++) { const x = ((i * 37 + 11) % (w - 10)) + 5; g.fillRect(x, base - ox - 2, 2.5, 2.5); }
  if (s.hTerm) { g.fillStyle = '#e0f0ff'; g.font = '9px ' + fontFam(); for (let x = 6; x < w; x += 16) g.fillText('H', x, base - 2); }
  // 水痕
  const nw = Math.min(8, Math.ceil(s.watermarks / 6));
  g.strokeStyle = '#e8e8e8';
  for (let i = 0; i < nw; i++) { const x = ((i * 71 + 23) % (w - 20)) + 10; g.beginPath(); g.ellipse(x, base + 6, 6, 2.5, 0, 0, Math.PI * 2); g.stroke(); }
  // 文字
  g.font = '11px ' + fontFam();
  g.fillStyle = '#d6dde8';
  g.fillText(liq ? `缝里：${liq.name}` : '缝里：干', 6, 13);
  const sig = liq ? stressGPa(liq.gamma, liq.full ? 1 : SURF.qdrFactor) : 0;
  g.textAlign = 'right';
  g.fillText(liq ? `毛细应力 ≈ ${sig.toFixed(2)} GPa（干燥时）` : '', w - 6, 13);
  g.textAlign = 'left';
  const leg = [['#b9c2d3', '线条'], ['#9fb8e8', '氧化膜'], ['#8a5a2b', '有机物'], ['#f2d16b', '颗粒'], ['#ff6060', 'Fe']];
  let lx = 6;
  for (const [col, t] of leg) { g.fillStyle = col; g.fillRect(lx, h - 12, 8, 8); g.fillStyle = '#d6dde8'; g.fillText(t, lx + 11, h - 4.5); lx += g.measureText(t).width + 18; }
  $('#patInfo').textContent = `倒 ${(s.collapse * 100).toFixed(1)}% · 颗粒 ${s.particles.toFixed(0)}`;
}

// ================= 面板：趋势图 =================
const samples = [];
let lastSample = -1, chartT0 = 0;   // chartT0：这一批（或这次换液）开始的时刻
const SERIES = [
  { name: '槽温', unit: '°C', min: 20, max: 150, lines: [['cb1', '#d9ae3c', () => L.cb1.T], ['cb2', '#3faa66', () => L.cb2.T], ['ob1', '#2f8fd6', () => L.ob1.T], ['ob2', '#17a2a2', () => L.ob2.T]] },
  { name: '比电阻', unit: 'MΩ·cm', log: true, min: 0.01, max: 20, lines: [['ob1', '#2f8fd6', () => L.ob1.rho], ['ob2', '#17a2a2', () => L.ob2.rho]] },
  { name: '单槽药液', unit: 'mol/L', log: true, min: 1e-9, max: 1, lines: [['H₂SO₄', '#d9ae3c', () => L.ob1.c.H2SO4], ['NH₃', '#3faa66', () => L.ob2.c.NH3], ['HF', '#e0609a', () => L.ob2.c.HF]] },
  { name: '单槽液位', unit: '%', min: 0, max: 100, lines: [['ob1', '#2f8fd6', () => L.ob1.level * 100], ['ob2', '#17a2a2', () => L.ob2.level * 100]] },
  { name: '干燥槽', unit: '', min: 0, max: 1, lines: [['O₂/21%', '#d64545', () => L.dr.o2 / 21], ['IPA', '#8a6fe0', () => L.dr.ipa], ['压力/大气压', '#5b6875', () => L.dr.pressure / 101.3]] },
];
function recordSample() {
  if ((L.stepIdx < 0 && !taskRunning) || L.t - lastSample < 4) return;
  lastSample = L.t;
  samples.push({ t: L.t - chartT0, v: SERIES.map(s => s.lines.map(l => l[2]())) });
}
function drawChart() {
  const c = $('#chart'), [w, h] = fitCanvas(c), g = c.getContext('2d'), cs = css();
  const bg = cs.getPropertyValue('--chart-bg'), fg = cs.getPropertyValue('--fg'), muted = cs.getPropertyValue('--muted');
  g.clearRect(0, 0, w, h);
  const now = Math.max(L.t - chartT0, 1), win = Math.max(600, now);
  const left = 112, rowH = (h - 14) / SERIES.length;
  g.font = '11px ' + fontFam();
  SERIES.forEach((s, i) => {
    const y0 = i * rowH, y1 = y0 + rowH - 3;
    g.fillStyle = bg; g.fillRect(left, y0, w - left, rowH - 3);
    g.fillStyle = muted; g.fillText(`${s.name}${s.unit ? '（' + s.unit + '）' : ''}`, 2, y0 + 12);
    const yv = v => s.log ? y1 - (Math.log10(clamp(v, s.min, s.max)) - Math.log10(s.min)) / (Math.log10(s.max) - Math.log10(s.min)) * (y1 - y0 - 4) : y1 - clamp((v - s.min) / (s.max - s.min), 0, 1) * (y1 - y0 - 4);
    let lx = 2;
    s.lines.forEach(([nm, col], j) => {
      g.strokeStyle = col; g.lineWidth = 1.4; g.beginPath();
      let started = false;
      for (const p of samples) {
        const x = left + p.t / win * (w - left), y = yv(p.v[i][j]);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = col;
      g.fillText(nm, lx, y0 + 25);
      lx += g.measureText(nm).width + 6;
    });
  });
  g.fillStyle = muted;
  g.fillText(`0 ~ ${(win / 60).toFixed(0)} 分钟`, left, h - 2);
  $('#chartInfo').textContent = L.stepIdx >= 0 || taskRunning ? fmtTime(L.t - chartT0) : '';
}
const fmtTime = t => { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };

// ================= 运行页 =================
const stepsEl = $('#steps');
// 工艺步骤按配方的流程排出来（L.steps）；配方变了重排
function buildStepList() {
  const key = L.steps.map(s => s.name).join('|');
  if (stepsEl.dataset.key === key) return;
  stepsEl.dataset.key = key;
  stepsEl.innerHTML = '';
  L.steps.forEach(s => { const li = document.createElement('li'); li.innerHTML = `<span>${s.name}</span><span class="d"></span>`; stepsEl.appendChild(li); });
}
const nowText = st => (typeof st.now === 'function' ? st.now(L.R) : st.now);
function renderSteps() {
  buildStepList();
  [...stepsEl.children].forEach((li, i) => {
    const done = i < L.stepIdx || (i === L.stepIdx && !L.busy);
    li.className = done ? 'done' : i === L.stepIdx && L.busy ? 'cur' : '';
    li.querySelector('.d').textContent = L.stepTimes[i] != null ? fmtTime(L.stepTimes[i]) : '';
  });
  const go = $('#go');
  if (L.task) { go.textContent = `进行中：${L.task}（演示）…`; go.disabled = true; }
  else if (L.done) { go.textContent = '↻ 再跑一批'; go.disabled = false; }
  else if (L.busy) { go.textContent = `进行中：${L.steps[L.stepIdx].name} …`; go.disabled = true; }
  else { const n = L.steps[L.stepIdx + 1]; go.textContent = (L.stepIdx < 0 ? '▶ 开始：' : '▶ 下一步：') + n.name; go.disabled = false; }
  const st = $('#state');
  st.className = 'pill' + (L.busy || (L.stepIdx >= 0 && !L.done) ? ' run' : L.done ? ' ok' : '');
  st.textContent = L.task ? '维护中' : L.done ? '完成' : L.stepIdx < 0 ? '待机' : L.busy ? `第 ${L.stepIdx + 1}/${L.steps.length} 步` : `等待第 ${L.stepIdx + 2} 步`;
  syncRecipeLock();
}
function explain(title, now, why, err = false) {
  const ex = $('#explain');
  ex.classList.toggle('err', err);
  ex.querySelector('.t').textContent = title;
  ex.querySelector('.now').textContent = now;
  const w = ex.querySelector('.why');
  w.textContent = why || '';
  w.hidden = !why;
}
let autoTimer = null, wasBusy = false;
function runStep(i) {
  clearTimeout(autoTimer);
  L.startStep(i);
  wasBusy = true;   // 很短的步骤在高倍速下可能一帧之内就做完，这里先记下"在忙"，完成才不会漏掉
  const st = L.steps[i];
  explain(`第 ${i + 1} 步 · ${st.name}`, nowText(st), st.why);
  lastFocus = null;
  if (follow()) { camTo(st.focus); lastFocus = st.focus; }
  renderSteps();
}
let taskRunning = false;
function onStepDone() {
  if (taskRunning) {
    taskRunning = false;
    renderSteps();
    explain(`${L.lastTask}完成`, '新药液已经升到设定温度，循环泵和加热器在运行。可以开始跑批了。', '');
    $('#explain .phase').textContent = '';
    $('#caption').innerHTML = `<b>${L.lastTask}完成</b> · 点右边"▶ 开始"跑一批`;
    return;
  }
  renderSteps();
  if (L.done) { finish(); return; }
  if ($('#auto').checked) autoTimer = setTimeout(() => { if (!L.busy && !L.done) runStep(L.stepIdx + 1); }, 600);
}
function startOrNext() {
  if (L.busy) return;
  if (L.done) { resetAll(); return; }
  if (L.stepIdx < 0) { samples.length = 0; lastSample = -1; chartT0 = L.t; }
  runStep(L.stepIdx + 1);
}
$('#go').addEventListener('click', startOrNext);
$('#auto').addEventListener('change', () => { if ($('#auto').checked && !L.busy && L.stepIdx >= 0 && !L.done) runStep(L.stepIdx + 1); });
$('#speed').addEventListener('change', e => { speed = +e.target.value; });
$('#pause').addEventListener('click', () => { paused = !paused; $('#pause').textContent = paused ? '▶ 继续' : '⏸ 暂停'; });

function resetAll() {
  clearTimeout(autoTimer);
  L = new Line(R);
  samples.length = 0; lastSample = -1; chartT0 = 0; lastFocus = null;
  explain('准备好了', '两个 FOUP 里又放了新的晶圆。可以先到"配方"里改参数，再点"开始"。', '每次只改一两个参数，对比结果最容易看出它的作用。');
  $('#caption').innerHTML = '点右边的 <b>▶ 开始</b>，一步一步把一批 50 片晶圆洗完。';
  if (follow()) camTo('overview');
  renderSteps();
}

// ---------- 主控 ↔ 子控：子控忙不忙、最近的消息 ----------
const ADDR = { main: '主控', loader: '装载', transfer: '搬送', cb1: '药液槽 1', ob1: '单槽 1', cb2: '药液槽 2', ob2: '单槽 2', dr: '干燥槽' };
const CMD = { DOCK: 'FOUP 到位', DOOR: '开 / 关门', MAP: '映射', TAKE: '取片', POSTURE: '姿态变换', RETURN: '分回 FOUP', MOVE: '移动', HOLD: '等待', PICK: '接片', PLACE: '放片', CHUCK_CLEAN: '洗夹爪', LIFT: '升降', RUN_UNIT: '执行单元', EXCHANGE: '换液' };
function cmdText(b) {
  const arg = b.cmd === 'LIFT' ? ` z=${b.z}` : b.cmd === 'MOVE' ? ` x=${b.x.toFixed(2)}` : b.cmd === 'RUN_UNIT' ? `「${b.unit.name}」${b.unit.steps.length} 步` : b.cmd === 'HOLD' ? ` ${b.s} s` : (b.cmd === 'PICK' || b.cmd === 'PLACE') ? ` ${b.nm}` : '';
  return `${b.cmd}${arg}（${CMD[b.cmd] || ''}）`;
}
let msgSeen = -1, msgBus = null;
function updateBus() {
  if (L.bus !== msgBus) { msgBus = L.bus; msgSeen = -1; }     // 新的一批（新机台状态）：消息编号从头开始
  $('#subs').innerHTML = L.subs.map(s => `<span class="${s.jobs.length ? 'busy' : ''}" title="${s.jobs.map(j => j.cmd).join('、') || '空闲'}">${ADDR[s.addr]}${s.jobs.length ? ' · ' + s.jobs.map(j => j.cmd).join('+') : ''}</span>`).join('');
  const log = L.bus.log, last = log.length ? log[log.length - 1].id : 0;
  if (last === msgSeen) return;
  msgSeen = last;
  $('#msgs').innerHTML = log.slice(-40).reverse().map(m => {
    const body = m.type === 'cmd' ? cmdText(m.body) : m.type === 'done' ? `做完了 ${m.body.cmd}` : `报警：${m.body.msg}`;
    return `<li class="${m.type}"><span class="tm">${fmtTime(m.t - chartT0)}</span><span>${ADDR[m.from]} → ${ADDR[m.to]}：${body}</span></li>`;
  }).join('') || '<li><span></span><span>还没有消息</span></li>';
}

// ---------- 实时数值 ----------
const VALS = [
  ['现在', () => L.phase || '—'],
  ['机械手', () => L.robot.task || '—'],
  ['药液槽 1 · SPM', () => `${L.cb1.T.toFixed(0)} °C · 液位 ${(L.cb1.innerLevel * 100).toFixed(0)}% · 泵${L.cb1.pump ? '开' : '停'}`],
  ['药液槽 2 · SC1', () => `${L.cb2.T.toFixed(0)} °C · 泵${L.cb2.pump ? '开' : '停'} · 兆声${L.cb2.mega ? '开' : '关'}`],
  ['单槽 1', () => `ρ ${fmtRho(L.ob1.rho)} MΩ·cm · ${L.ob1.T.toFixed(0)} °C`],
  ['单槽 2', () => `ρ ${fmtRho(L.ob2.rho)} · HF ${L.ob2.c.HF > 1e-9 ? L.ob2.c.HF.toExponential(1) : '0'} M`],
  ['减压干燥槽', () => `O₂ ${L.dr.o2.toFixed(1)}% · ${L.dr.pressure.toFixed(0)} kPa · IPA ${(L.dr.ipa * 100).toFixed(0)}%`],
  ['热氧化膜损失', () => `${L.surf.thermOxLoss.toFixed(2)} nm`],
  ['DIW 用量', () => `${L.usage().diwL.toFixed(0)} L`],
];
const valsEl = $('#vals');
valsEl.innerHTML = VALS.map(([a], i) => `<dt>${a}</dt><dd id="v${i}"></dd>`).join('');
const valEls = VALS.map((_, i) => $('#v' + i));
function updateVals() { VALS.forEach(([, f], i) => { valEls[i].textContent = f(); }); }

// ---------- 结果 ----------
function finish() {
  const ev = evaluate(L);
  const v = $('#verdict');
  v.className = 'verdict ' + (ev.bad ? 'bad' : 'ok');
  v.textContent = ev.bad ? `有 ${ev.bad} 项不合格` : '合格：这一批洗得很好 ✓';
  $('#resList').innerHTML = ev.items.map(i => `<li class="${i.ok ? 'ok' : 'bad'}"><div class="h"><span>${i.label}</span><span class="v">${i.val}</span></div>${i.ok ? '' : `<div class="hint">${i.hint}</div>`}</li>`).join('');
  const warn = [...ev.notes, ...ev.violations.map(x => '联锁：' + x.msg)];
  $('#resWarn').innerHTML = warn.map(x => `⚠ ${x}`).join('<br>');
  $('#resStats').textContent = ev.stats.join(' · ') + ' · 搬送在空气里：' + L.air.log.map(a => `${a.t.toFixed(0)} s`).join(' / ');
  $('#result').hidden = false;
  explain('完成', '50 片晶圆都回到了原来 FOUP 的原来槽位。结果在弹窗里；关掉弹窗还能看左下角的曲线和图形。', '');
  $('#caption').innerHTML = '<b>完成</b> · 点右边"再跑一批"，或者改配方再试';
}
$('#again').addEventListener('click', () => { $('#result').hidden = true; resetAll(); });
$('#tweak').addEventListener('click', () => { $('#result').hidden = true; resetAll(); showTab('recipe'); });
$('#resClose').addEventListener('click', () => { $('#result').hidden = true; });

// ================= 配方页：流程（flow）→ 单元（unit）→ 步骤（step） =================
const presetsEl = $('#presets');
let selUnit = DEFAULT.flow.units[0];
let lastPred = null;                 // 最近一次预测跑出来的机台（拿它显示每一步实际用了多久）
let lastLocked = null;
const recipeLocked = () => L.busy || (L.stepIdx >= 0 && !L.done);
const fmtS = s => (s >= 90 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`);
const dis = () => (recipeLocked() ? 'disabled' : '');

function renderPresets() {
  presetsEl.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'btn' + (sameRecipe(R, p.r) ? ' on' : '');
    b.textContent = p.name;
    b.disabled = recipeLocked();
    b.onclick = () => { R = cloneRecipe(p.r); recipeChanged(true); };
    presetsEl.appendChild(b);
  }
}

// 预测跑出来的时间：一个单元一共用了多久
function unitTime(id) {
  if (!lastPred) return null;
  const recs = lastPred.stepLog.filter(r => r.unit === id && r.t1 != null);
  return recs.length ? recs.reduce((a, r) => a + r.t1 - r.t0, 0) : null;
}
function renderFlow() {
  $('#flowName').textContent = R.flow.name;
  $('#flow').innerHTML = R.flow.units.map((id, i) => {
    const u = R.units[id], b = BATHS[u.bath], t = unitTime(id);
    return `<li data-u="${id}" class="${id === selUnit ? 'on' : ''}" title="${describeSteps(u.steps)}"><b>${i + 1}</b><span class="bn">${b.name}</span><span class="un">${u.name}</span><span class="sm">${u.steps.length} 步${t != null ? ' · ' + fmtS(t) : ''}</span></li>`;
  }).join('');
  const ax = $('#airExtra');
  ax.value = R.flow.airExtraS; ax.disabled = recipeLocked();
  $('#airExtraV').textContent = R.flow.airExtraS;
}

// 一个输入项。path：'cond'（药液槽的条件）或者步骤的序号
function fieldHtml(f, obj, path) {
  const v = obj[f.k], d = dis(), at = `data-p="${path}" data-f="${f.k}" ${d}`;
  if (f.type === 'toggle') return `<label class="chk sf"><input type="checkbox" ${at} ${v ? 'checked' : ''}>${f.name}</label>`;
  if (f.type === 'select') return `<label class="sf">${f.name} <select ${at}>${f.options.map(([o, t]) => `<option value="${o}" ${o === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
  return `<label class="sf">${f.name} <input type="number" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}" ${at}>${f.unit ? `<i>${f.unit}</i>` : ''}</label>`;
}
const fieldsOf = (u, s) => STEP_KINDS[s.kind].fields.filter(f => (!f.need || BATHS[u.bath][f.need]) && (!f.when || f.when(s)));

function renderUnit() {
  const u = R.units[selUnit], b = BATHS[u.bath], d = dis();
  $('#unitTitle').innerHTML = `单元（unit）<span class="sub">${b.name} · ${u.name}</span>`;
  $('#unitCond').innerHTML = b.type === 'chembath'
    ? `<div class="cond"><span class="lb">槽的条件</span>${COND_FIELDS[b.kind].map(f => fieldHtml(f, u.cond, 'cond')).join('')}</div>` : '';
  $('#usteps').innerHTML = u.steps.map((s, i) => `<li data-i="${i}">
      <div class="sh"><b>${i + 1}</b><span class="k">${STEP_KINDS[s.kind].name}</span><span class="act"></span>
        <span class="ops"><button data-op="up" title="上移" ${i === 0 ? 'disabled' : d}>↑</button><button data-op="down" title="下移" ${i === u.steps.length - 1 ? 'disabled' : d}>↓</button><button data-op="del" title="删掉这一步" ${d}>✕</button></span></div>
      <div class="sfs">${fieldsOf(u, s).map(f => fieldHtml(f, s, i)).join('')}</div></li>`).join('')
    || '<li class="empty">这个单元没有步骤：晶圆放进去马上就拿出来。</li>';
  $('#addKind').innerHTML = Object.entries(STEP_KINDS).filter(([, K]) => K.bath === b.type).map(([k, K]) => `<option value="${k}">${K.name}</option>`).join('');
  $('#addKind').disabled = $('#addStep').disabled = recipeLocked();
  $('#stepTip').textContent = '';
  updateTimes();
}

// 预测跑完以后，只改时间的字，不重画输入框（免得正在输入的框失去焦点）
function updateTimes() {
  for (const li of $('#flow').children) {
    const id = li.dataset.u, t = unitTime(id);
    li.querySelector('.sm').textContent = `${R.units[id].steps.length} 步${t != null ? ' · ' + fmtS(t) : ''}`;
  }
  const recs = lastPred ? lastPred.stepLog.filter(r => r.unit === selUnit && r.t1 != null) : [];
  for (const li of $('#usteps').querySelectorAll('li[data-i]')) {
    const r = recs.find(x => x.i === +li.dataset.i);
    li.querySelector('.act').textContent = r ? `实际 ${fmtS(r.t1 - r.t0)}` : '';
  }
}

// structural：步骤增删、换顺序、出现 / 消失输入项时才重画单元
function recipeChanged(structural = false) {
  renderPresets();
  renderFlow();
  if (structural) renderUnit();
  applyRecipe();
  schedulePredict();
}
$('#flow').addEventListener('click', e => {
  const li = e.target.closest('li[data-u]');
  if (!li) return;
  selUnit = li.dataset.u;
  renderFlow(); renderUnit();
});
$('#tab-recipe').addEventListener('change', e => {
  const el = e.target, f = el.dataset.f;
  if (!f || recipeLocked()) return;
  const u = R.units[selUnit], obj = el.dataset.p === 'cond' ? u.cond : u.steps[+el.dataset.p];
  let v = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.tagName === 'SELECT' ? el.value : +el.value;
  if (el.type === 'number') {
    if (!isFinite(v) || el.value === '') v = obj[f];
    v = Math.min(+el.max, Math.max(+el.min, v));
    el.value = v;
  }
  obj[f] = v;
  recipeChanged(f === 'end');
});
$('#tab-recipe').addEventListener('focusin', e => {
  const el = e.target, f = el.dataset.f;
  if (!f) return;
  const u = R.units[selUnit];
  const defs = el.dataset.p === 'cond' ? COND_FIELDS[BATHS[u.bath].kind] : STEP_KINDS[u.steps[+el.dataset.p].kind].fields;
  const def = defs.find(x => x.k === f);
  $('#stepTip').textContent = def && def.tip ? def.tip : '';
});
$('#usteps').addEventListener('click', e => {
  const op = e.target.dataset.op;
  if (!op || recipeLocked()) return;
  const i = +e.target.closest('li').dataset.i, st = R.units[selUnit].steps;
  if (op === 'del') st.splice(i, 1);
  else { const j = op === 'up' ? i - 1 : i + 1; [st[i], st[j]] = [st[j], st[i]]; }
  recipeChanged(true);
});
$('#addStep').addEventListener('click', () => {
  if (recipeLocked()) return;
  R.units[selUnit].steps.push(newStep($('#addKind').value));
  recipeChanged(true);
});
$('#airExtra').addEventListener('input', e => {
  if (recipeLocked()) return;
  R.flow.airExtraS = +e.target.value;
  recipeChanged();
});
// 跑批中配方锁住；锁的状态变了才重画
function syncRecipeLock() {
  const locked = recipeLocked();
  $('#lockNote').hidden = !locked;
  if (locked === lastLocked) return;
  lastLocked = locked;
  renderPresets(); renderFlow(); renderUnit();
}
// 配方变了：没开始跑时，换一台新的机台状态
function applyRecipe() { if (L.stepIdx < 0) { L = new Line(R); renderSteps(); } }
let predTimer = null;
function schedulePredict() {
  clearTimeout(predTimer);
  predTimer = setTimeout(() => {
    lastPred = simulate(R, 0.5);
    const ev = evaluate(lastPred);
    $('#predict').innerHTML = ev.items.map(i => `<li class="${i.ok ? 'ok' : 'bad'}"><div class="h"><span>${i.label}</span><span class="v">${i.val}</span></div></li>`).join('');
    $('#predictStats').textContent = ev.stats.join(' · ');
    updateTimes();
  }, 250);
}
renderPresets(); renderFlow(); renderUnit(); schedulePredict();

// ================= 零件页 =================
{
  const byGroup = {};
  for (const p of Object.values(PARTS)) if (p.desc) (byGroup[p.grp] ||= []).push(p);
  const pl = $('#plist');
  for (const [grp, list] of Object.entries(byGroup)) {
    const d = document.createElement('div');
    d.className = 'pgroup';
    d.innerHTML = `<h4>${grp}</h4><div class="plist">${list.map(p => `<button data-p="${p.id}">${p.name.replace(/^.* · /, '')}</button>`).join('')}</div>`;
    pl.appendChild(d);
  }
  pl.addEventListener('click', e => { const id = e.target.dataset.p; if (id) { pickedRoot = null; selectPart(id, true); } });
}
let selected = null;
function setHL(id, on) {
  if (!id || !PARTS[id]) return;
  for (const o of PARTS[id].objs) o.traverse(m => {
    if (m.isMesh && m.material.emissive) { m.material.emissive.setHex(on ? 0xff7a1a : 0x000000); m.material.emissiveIntensity = on ? 0.6 : 1; }
  });
}
function selectPart(id, fromList = false) {
  setHL(selected, false);
  selected = id;
  setHL(id, true);
  document.querySelectorAll('#plist button').forEach(b => b.classList.toggle('on', b.dataset.p === id));
  const card = $('#partcard');
  if (!id || !PARTS[id]) { card.hidden = true; return; }
  const p = PARTS[id];
  card.querySelector('h3').textContent = p.name;
  card.querySelector('.g').textContent = p.grp;
  card.querySelector('p').textContent = p.desc;
  card.hidden = false;
  if (fromList && !L.busy) {
    const pre = id.split('_')[0];
    const v = TANKS.includes(pre) ? pre : ['lp1', 'lp2', 'foup1', 'foup2', 'mapper', 'batch_robot', 'posture'].includes(id) ? 'loader' : id === 'chuck_clean' ? 'chuck' : null;
    if (v) camTo(v);
  }
}
$('#pcClose').addEventListener('click', () => selectPart(null));
// 拉近看：在 3D 里点中的是哪一个就看哪一个（例如某一个阀）；从列表选的就把这一类全框进来
let pickedRoot = null;
function zoomToPart() {
  if (!selected || !PARTS[selected]) return;
  const objs = pickedRoot && PARTS[selected].objs.includes(pickedRoot) ? [pickedRoot] : PARTS[selected].objs;
  const bb = new THREE.Box3();
  objs.forEach(o => bb.expandByObject(o));
  const c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3()).length();
  const dir = new THREE.Vector3(0.45, 0.35, 1).normalize();
  $('#follow').checked = false;      // 不然镜头跟随会把镜头拉回去
  camAnim = { p0: camera.position.clone(), t0: controls.target.clone(), p1: c.clone().addScaledVector(dir, Math.max(0.16, size * 1.3)), t1: c, k: 0 };
  document.querySelectorAll('#views button').forEach(b => b.classList.remove('on'));
}
$('#pcZoom').addEventListener('click', zoomToPart);

// ---------- 页签、顶栏 ----------
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + name; });
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.querySelectorAll('#views button').forEach(b => b.addEventListener('click', () => camTo(b.dataset.v)));
$('#labels').addEventListener('change', e => { labelRenderer.domElement.style.display = e.target.checked ? '' : 'none'; });
$('#front').addEventListener('change', e => { frontPanel.material = e.target.checked ? MAT.glass : MAT.panel; });
$('#dockToggle').addEventListener('click', () => { const d = $('#dock'); d.hidden = !d.hidden; $('#dockToggle').textContent = d.hidden ? '显示图表' : '隐藏图表'; });

// ---------- 点选 ----------
const ray = new THREE.Raycaster();
let downXY = null;
canvas.addEventListener('pointerdown', e => { downXY = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', e => {
  if (!downXY || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  for (const hh of ray.intersectObjects(scene.children, true)) {
    const o = hh.object;
    if (!o.isMesh || !o.visible || o === waferMesh) continue;
    const m = o.material;
    if (m.userData.noPick || (m.transparent && m.opacity < 0.3 && !m.userData.pick)) continue;
    if (!o.userData.part) continue;
    pickedRoot = o;
    while (pickedRoot.parent && pickedRoot.parent !== scene) pickedRoot = pickedRoot.parent;
    selectPart(o.userData.part);
    return;
  }
  selectPart(null);
});

// ================= 管路图（2D，按 sim/piping.js 的同一份数据画） =================
const NS = 'http://www.w3.org/2000/svg';
const hexStr = n => '#' + n.toString(16).padStart(6, '0');
function svgEl(tag, attrs, parent, text) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
let pidView = 'cb1', PE = null, pidSel = null;
const pidTemplate = () => PIPING.templates.find(t => t.id === pidView);
const DRAIN_NAME = { V_DA: '酸排液', V_DK: '碱排液', V_DREC: '回收' };
function renderPid() {
  const svg = $('#pidSvg');
  svg.innerHTML = '';
  const t = pidTemplate(), B = t.box2;
  PE = { edges: {}, layer: null, valves: {}, pump: null, heater: null, inLiq: null, outLiq: null, inst: {}, sym: {} };
  const addSym = (id, el) => { (PE.sym[id] ||= []).push(el); return el; };
  const mk = svgEl('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, svgEl('defs', {}, svg));
  svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#7d8790' }, mk);
  // 槽：照作者的概要图，内槽（单槽是槽本体）画在外槽（单槽是接液槽）里面
  const [ox, oy, ow, oh] = B.out, [ix, iy, iw, ih] = B.in;
  const gO = svgEl('g', { class: 'cmp', 'data-id': B.outId }, svg);
  addSym(B.outId, svgEl('rect', { x: ox, y: oy, width: ow, height: oh, class: 'tank' }, gO));
  PE.outLiq = svgEl('rect', { x: ox + 1, y: oy + oh - 1, width: ow - 2, height: 0, opacity: 0.45 }, gO);
  svgEl('text', { x: B.outLabelAt[0], y: B.outLabelAt[1], 'text-anchor': B.outLabelAt[2], class: 'lbl' }, gO, B.outLabel);
  const gI = svgEl('g', { class: 'cmp', 'data-id': B.inId }, svg);
  addSym(B.inId, svgEl('rect', { x: ix, y: iy, width: iw, height: ih, class: 'tank' }, gI));
  PE.inLiq = svgEl('rect', { x: ix + 1, y: iy + ih - 1, width: iw - 2, height: 0, opacity: 0.5 }, gI);
  svgEl('text', { x: ix + iw / 2, y: iy + ih - 8, 'text-anchor': 'middle', class: 'lbl' }, gI, B.inLabel);
  // 管段放在同一层：开始流的管子挪到这一层最上面（几条管共用一段时不被没在流的盖住）
  PE.layer = svgEl('g', {}, svg);
  for (const e of t.edges) {
    PE.edges[e.id] = svgEl('polyline', { points: e.r2.map(p => p.join(',')).join(' '), class: 'pe' + (e.sys === 'exhaust' ? ' ex' : ''), 'marker-end': 'url(#arr)' }, PE.layer);
  }
  // 公共设施接口（同一个接口可以画在几处，例如 DIW）
  for (const fid in t.fac) {
    const pos = Array.isArray(t.fac[fid][0]) ? t.fac[fid] : [t.fac[fid]];
    for (const [fx, fy] of pos) {
      const g = svgEl('g', { class: 'cmp', 'data-id': fid }, svg);
      addSym(fid, svgEl('rect', { x: fx - 24, y: fy - 9, width: 48, height: 18, rx: 4, class: 'fac' }, g));
      svgEl('text', { x: fx, y: fy + 4, 'text-anchor': 'middle', style: 'font-size:11px' }, g, PIPING.nodes[fid].label);
    }
  }
  // 元件（符号参考 ISA 5.1 的通用画法）
  for (const nid in t.nodes) {
    const n = t.nodes[nid];
    if (n.kind === 'device') {
      const [rx, ry, rw, rh] = n.rect, g = svgEl('g', { class: 'cmp', 'data-id': nid }, svg);
      addSym(nid, svgEl('rect', { x: rx, y: ry, width: rw, height: rh, class: 'sym', fill: 'var(--muted)' }, g));
      svgEl('text', { x: rx + rw / 2, y: ry + rh + 12, 'text-anchor': 'middle', class: 'lbl', style: 'font-size:10px' }, g, n.label);
      continue;
    }
    if (!n.at) continue;
    const [x, y] = n.at;
    const g = svgEl('g', { class: 'cmp', 'data-id': nid }, svg);
    if (n.kind === 'valve') {
      // 竖管上的阀（rot）整个转 90°，执行器朝右
      const v = svgEl('g', n.rot ? { transform: `rotate(90 ${x} ${y})` } : {}, g);
      PE.valves[nid] = addSym(nid, svgEl('path', { d: `M${x - 10},${y - 7} L${x - 10},${y + 7} L${x + 10},${y - 7} L${x + 10},${y + 7} Z`, class: 'sym' }, v));
      svgEl('line', { x1: x, y1: y, x2: x, y2: y - 12, class: 'sym' }, v);
      svgEl('rect', { x: x - 6, y: y - 18, width: 12, height: 6, class: 'sym', fill: 'none' }, v);
      svgEl('text', n.rot ? { x: x + 22, y: y + 4, class: 'tag' } : { x: x + 13, y: y - 8, class: 'tag' }, g, n.tag);
    } else if (n.kind === 'pump') {
      PE.pump = addSym(nid, svgEl('circle', { cx: x, cy: y, r: 14, class: 'sym' }, g));
      svgEl('path', { d: `M${x - 8},${y - 5} L${x + 8},${y - 5} L${x},${y + 9} Z`, fill: 'none', class: 'sym' }, g);
      svgEl('text', { x: x - 20, y: y + 4, 'text-anchor': 'end', class: 'lbl' }, g, '循环泵');
    } else if (n.kind === 'heater') {
      PE.heater = addSym(nid, svgEl('rect', { x: x - 28, y: y - 9, width: 56, height: 18, class: 'sym' }, g));
      svgEl('polyline', { points: `${x - 22},${y} ${x - 15},${y - 6} ${x - 7},${y + 6} ${x},${y - 6} ${x + 7},${y + 6} ${x + 15},${y - 6} ${x + 22},${y}`, fill: 'none', class: 'sym' }, g);
      svgEl('text', { x, y: y + 24, 'text-anchor': 'middle', class: 'lbl' }, g, '加热器');
    } else if (n.kind === 'filter') {
      addSym(nid, svgEl('path', { d: `M${x},${y - 16} L${x + 16},${y} L${x},${y + 16} L${x - 16},${y} Z`, class: 'sym', fill: 'var(--panel)' }, g));
      svgEl('line', { x1: x, y1: y - 16, x2: x, y2: y + 16, class: 'sym', 'stroke-dasharray': '3 2' }, g);
      svgEl('text', { x: x + 20, y: y + 4, class: 'lbl' }, g, '过滤器');
    } else if (n.kind === 'mixer') {
      const [rx, ry, rw, rh] = n.rect;
      addSym(nid, svgEl('rect', { x: rx, y: ry, width: rw, height: rh, class: 'sym', fill: 'var(--panel)' }, g));
      svgEl('text', { x: rx + rw + 5, y: ry + rh / 2 + 4, class: 'lbl' }, g, n.label);
    } else if (n.kind === 'unit') {
      addSym(nid, svgEl('rect', { x: x - 24, y: y - 12, width: 48, height: 24, rx: 3, class: 'sym', fill: 'var(--panel)' }, g));
      svgEl('text', { x, y: y + 4, 'text-anchor': 'middle', style: 'font-size:10px' }, g, n.short);
    } else if (n.kind === 'junction') {
      svgEl('circle', { cx: x, cy: y, r: 9, fill: 'transparent' }, g);     // 点的范围大一点，好点中
      addSym(nid, svgEl('circle', { cx: x, cy: y, r: 3.5, class: 'sym', fill: 'var(--fg)' }, g));
    } else if (n.kind === 'nozzle') {
      addSym(nid, svgEl('path', { d: `M${x - 8},${y - 8} L${x + 8},${y - 8} L${x},${y + 4} Z`, class: 'sym', fill: 'var(--panel)' }, g));
      svgEl('text', { x: x + 12, y: y, class: 'lbl' }, g, n.label);
    }
  }
  // 仪表
  for (const it of t.inst) {
    const [x, y] = it.at, on = t.nodes[it.on];
    const tg = it.to || on.at || [ox + ow, y];
    svgEl('line', { x1: x, y1: y, x2: tg[0], y2: tg[1], class: 'lead' }, svg);
    svgEl('circle', { cx: x, cy: y, r: 13, class: 'inst' }, svg);
    svgEl('text', { x, y: y + 3.5, 'text-anchor': 'middle', class: 'tag' }, svg, it.tag);
    PE.inst[it.tag] = svgEl('text', { x: x + 17, y: y + 4, class: 'tag' }, svg, '');
  }
  pidSel = null;
  $('#pidLeg').innerHTML = t.legend.map(f => `<span><i style="background:${hexStr(FLUID_COL[f])}"></i>${FLUID_NAME[f]}</span>`).join('')
    + `<span><i style="background:${hexStr(VALVE_OPEN)}"></i>阀门开${t.type === 'chembath' ? ' / 泵运行' : ''}</span>`
    + (t.type === 'chembath' ? '<span><i style="background:#e08a4a"></i>加热器开</span>' : '') + '<span><i style="background:#9aa3ab"></i>没在流</span>';
  $('#pidEx').hidden = t.type !== 'chembath';
  $('#pidTip').textContent = t.type === 'chembath'
    ? '点阀门、泵、加热器、过滤器看它是干什么的。正在流的管子按液体颜色显示，虚线往流动方向走。'
    : '单槽每批现配、用完排掉，没有换液；阀门跟着跑批走（第 5～8 步）。点阀门、混合块、接液槽看它是干什么的；注意排液分流什么时候从酸 / 碱切到回收。';
}
function setLiq(el, box, frac, col) {
  const [, y, , h] = box, hh = frac * (h - 2);
  el.setAttribute('y', y + h - 1 - hh); el.setAttribute('height', hh); el.style.fill = col;
}
function updatePid(pip) {
  if ($('#pid').hidden || !PE) return;
  const t = pidTemplate();
  for (const eid in PE.edges) {
    const f = pip.flows[eid] || '', el = PE.edges[eid];
    if (el.dataset.f === f) continue;     // 只在变化时改：重新插进 DOM 会让流动动画从头开始
    el.dataset.f = f;
    el.classList.toggle('flow', !!f);
    el.style.stroke = f ? hexStr(FLUID_COL[f]) : '';
    if (f) PE.layer.appendChild(el);
  }
  for (const vid in PE.valves) PE.valves[vid].style.fill = pip.state.open[vid] ? hexStr(VALVE_OPEN) : 'var(--panel)';
  const bad = pip.bad.filter(b => b.startsWith(t.id + '.') || b.startsWith(t.id + '：'));
  const tail = bad.length ? ` · ⚠ ${bad[0]}` : '';
  if (t.type === 'chembath') {
    const cb = L[t.id];
    PE.pump.style.fill = cb.pump ? hexStr(VALVE_OPEN) : 'var(--panel)';
    PE.heater.style.fill = cb.heater ? '#e08a4a' : 'var(--panel)';
    const fl = cb.fluid(), fcol = fl ? hexStr(FLUID_COL[fl]) : 'none';
    setLiq(PE.inLiq, t.box2.in, cb.innerLevel, fcol);
    setLiq(PE.outLiq, t.box2.out, cb.outerLevel * 110 / (t.box2.out[3] - 2), fcol);
    PE.inst.TT.textContent = `${cb.T.toFixed(1)} °C`;
    PE.inst.LT.textContent = `${(cb.outerLevel * 100).toFixed(0)} %`;
    PE.inst.PDT.textContent = cb.pump ? '25 kPa（示意）' : '0';
    const last = cb.interlockLog[cb.interlockLog.length - 1];
    $('#pidInfo').textContent = `${FLUID_NAME[fl] || '空'} · 泵${cb.pump ? '运行' : '停'} · 加热器${cb.heater ? '开' : '关'} · ${cb.T.toFixed(1)} / ${cb.Tset} °C · 内槽 ${(cb.innerLevel * 100).toFixed(0)}% · 外槽 ${(cb.outerLevel * 100).toFixed(0)}%`
      + (last ? ` · 联锁：${last}` : '') + tail;
    const ex = $('#pidEx');
    ex.disabled = !L.canMaintain;
    ex.textContent = L.task ? '换液中…' : '换液（演示）';
  } else {
    const ob = L[t.id], fl = ob.fluid();
    setLiq(PE.inLiq, t.box2.in, ob.level, fl ? hexStr(FLUID_COL[fl]) : 'none');
    // 接液槽不存液：有液体落进来时画一薄层
    const pf = t.edges.filter(e => e.b === t.box2.outId).map(e => pip.flows[e.id]).find(Boolean);
    setLiq(PE.outLiq, t.box2.out, pf ? 0.05 : 0, pf ? hexStr(FLUID_COL[pf]) : 'none');
    PE.inst.AT.textContent = `${fmtRho(ob.rho)} MΩ·cm`;
    PE.inst.TT.textContent = `${ob.T.toFixed(1)} °C`;
    PE.inst.FT.textContent = `${ob.Q.toFixed(0)} L/min`;
    const dest = Object.keys(DRAIN_NAME).find(v => pip.state.open[`${t.id}.${v}`]);
    const doing = ob.dumping ? `快排${ob.shower ? ' + 淋浴' : ''}`
      : ob.Q > 0 ? `供液 ${ob.Q} L/min ${ob.Tin} °C` + (ob.inject ? ` + ${FLUID_NAME[ob.inject.species]} 1:${ob.inject.ratio}` : '') : '静止';
    $('#pidInfo').textContent = `${FLUID_NAME[fl] || '空'} · 液位 ${(ob.level * 100).toFixed(0)}% · ${ob.T.toFixed(1)} °C · 比电阻 ${fmtRho(ob.rho)} MΩ·cm · ${doing} · 排液 → ${dest ? DRAIN_NAME[dest] : '关'}` + tail;
  }
}
function setPidView(id) {
  pidView = id;
  document.querySelectorAll('#pidTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === id));
  renderPid(); updatePid(L.piping());
}
// 跟着晶圆：晶圆在哪个槽里，管路图就切到哪个槽
function followPid() {
  if ($('#pid').hidden || !$('#pidFollow').checked) return;
  const h = L.batch.holder;
  if (h !== pidView && PIPING.templates.some(t => t.id === h)) setPidView(h);
}
$('#pidBtn').addEventListener('click', () => { const p = $('#pid'); p.hidden = !p.hidden; if (!p.hidden) { renderPid(); updatePid(L.piping()); } });
$('#pidClose').addEventListener('click', () => { $('#pid').hidden = true; });
$('#pidTabs').addEventListener('click', e => {
  const t = e.target.dataset.t;
  if (!t) return;
  $('#pidFollow').checked = false;     // 自己点了就不再自动切
  setPidView(t);
});
$('#pidSvg').addEventListener('click', e => {
  const g = e.target.closest('.cmp');
  if (pidSel && PE.sym[pidSel]) PE.sym[pidSel].forEach(el => el.classList.remove('sel'));
  if (!g) { pidSel = null; return; }
  const id = g.dataset.id, n = PIPING.nodes[id];
  pidSel = id;
  if (PE.sym[id]) PE.sym[id].forEach(el => el.classList.add('sel'));
  const role = n.role || (n.kind === 'source' ? '公共设施的供应接口' : n.kind === 'sink' ? '公共设施的出口' : '');
  $('#pidTip').innerHTML = `<b>${n.tag ? n.tag + ' ' : ''}${n.label}</b>　${role}`;
});
$('#pidEx').addEventListener('click', () => {
  if (!L.startExchange(pidView)) return;
  taskRunning = true;
  wasBusy = true;
  if (L.stepIdx < 0 || L.done) { samples.length = 0; lastSample = -1; chartT0 = L.t; }
  explain(`${L.task}（演示）`, '换液：停加热器和循环泵 → 打开排液阀排掉旧液 → 依次补 DIW、药液 1、药液 2 → 外槽液位够了开泵 → 开加热器升温。看管路图里阀门和流向怎么变。',
    '先停泵和加热器：排液时泵会吸进空气空转，加热器没有液体流过会空烧。补液时内槽先满，再溢流到外槽；外槽液位够了才能开泵。');
  renderSteps();
});

// ================= 主循环 =================
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();
renderSteps();
if (innerWidth < 900) { $('#dock').hidden = true; $('#dockToggle').textContent = '显示图表'; $('#caption').textContent = '点下面的 ▶ 开始'; }
camTo('overview');

// 机械手、升降器在动的时候（"搬送时放慢"打开）速度最多 5×，方便看清交接
let motionPrev = '', moving = false;
function motionKey() {
  const lifts = TANKS.map(id => (id === 'dr' && L.drying ? 'd' : L.lift[id].toFixed(4))).join(',');
  const ld = L.loader;
  return `${L.robot.x.toFixed(4)}|${L.robot.chuck.toFixed(3)}|${lifts}|${ld.pick1.toFixed(3)}${ld.pick2.toFixed(3)}${ld.posture.toFixed(3)}${ld.door.toFixed(3)}${ld.map.toFixed(3)}|${L.dr.lid.toFixed(3)}`;
}

let last = performance.now(), simAcc = 0, uiAcc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  try { frameBody(now); } catch (e) { window.__showErr && window.__showErr(e); }
}
function frameBody(now) {
  const dtR = clamp((now - last) / 1000, 0, 0.1);
  last = Math.max(last, now);
  const sp = $('#slowmo').checked && moving ? Math.min(speed, 5) : speed;
  if (!paused && L.busy) simAcc += dtR * sp;
  let n = 0;
  while (simAcc >= SIM_DT && n < 4000 && L.busy) { simAcc -= SIM_DT; n++; L.step(SIM_DT); recordSample(); }
  if (!L.busy) simAcc = 0;
  // 步骤做完了（不管是这里推进的，还是调试时从外面推进的）
  if (wasBusy && !L.busy) onStepDone();
  wasBusy = L.busy;
  const mk = motionKey();
  moving = mk !== motionPrev;
  motionPrev = mk;
  followBatch();
  visualsTick(dtR);
  if (camAnim) {
    camAnim.k = Math.min(1, camAnim.k + dtR / 1.2);
    const e = ease(camAnim.k);
    camera.position.lerpVectors(camAnim.p0, camAnim.p1, e);
    controls.target.lerpVectors(camAnim.t0, camAnim.t1, e);
    if (camAnim.k >= 1) camAnim = null;
  }
  controls.update();
  renderer.render(scene, camera);
  if ($('#labels').checked) labelRenderer.render(scene, camera);
  uiAcc += dtR;
  if (uiAcc > 0.1) {
    uiAcc = 0;
    if (!$('#dock').hidden) { drawLine(); drawPattern(); drawChart(); }
    updateVals();
    updateBus();
    $('#time').textContent = fmtTime(L.t - chartT0);
    const pip = L.piping();
    updatePiping3D(pip);
    followPid();
    updatePid(pip);
    if (L.busy && L.task) {
      $('#caption').innerHTML = `<b>${L.task}（演示）</b><span class="ph">${L.phase}</span>`;
      $('#explain .phase').textContent = '现在：' + L.phase;
    } else if (L.busy) {
      const st = L.steps[L.stepIdx];
      $('#caption').innerHTML = `<b>第 ${L.stepIdx + 1}/${L.steps.length} 步</b> · ${st.name}<span class="ph">${L.phase}${L.robot.task && L.robot.task !== '待机' && !L.robot.holding ? ' · 机械手：' + L.robot.task : ''}</span>`;
      $('#explain .phase').textContent = '现在：' + L.phase;
    }
  }
}
window.__wetReady = true;
window.__wet = { get L() { return L; }, get camBusy() { return !!camAnim; }, camera, controls, scene, renderer, tick: frameBody, runStep, camTo, recordSample };   // 调试用
requestAnimationFrame(frame);
