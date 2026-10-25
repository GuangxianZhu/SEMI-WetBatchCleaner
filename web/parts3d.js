// 部件的三维模型：气动球阀、兆声振子和发生器、比电阻计、测温探头、显示仪表、泵、过滤器、加热器、流量控制。
// 外形参考公开的产品照片和公开专利里的通用结构（docs/资料来源.md D12），尺寸是示意，不对应任何厂家的机型。
// 每个部件把同一种材质的零碎几何合并成一个网格，网格数少，画得快。

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

let M = null;   // 材质，由 app.js 的 initParts 传进来
export function initParts(materials) { M = materials; }

// ---------- 几何小工具（都返回已经移到位置上的几何体） ----------
const G = {
  box: (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z),
  cylY: (r, h, x = 0, y = 0, z = 0, seg = 18) => new THREE.CylinderGeometry(r, r, h, seg).translate(x, y, z),
  cylX: (r, len, x = 0, y = 0, z = 0, seg = 18) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2).translate(x, y, z),
  cylZ: (r, len, x = 0, y = 0, z = 0, seg = 18) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2).translate(x, y, z),
  hexX: (r, len, x = 0, y = 0, z = 0) => new THREE.CylinderGeometry(r, r, len, 6).rotateZ(Math.PI / 2).translate(x, y, z),
  ball: (r, x = 0, y = 0, z = 0) => new THREE.SphereGeometry(r, 18, 12).translate(x, y, z),
};
const mesh = (geos, mat) => new THREE.Mesh(geos.length === 1 ? geos[0] : mergeGeometries(geos), mat);
const grp = (...objs) => { const g = new THREE.Group(); objs.forEach(o => o && g.add(o)); return g; };

// 电缆（细的折线管）
export function cable(pts, r = 0.0035) {
  const path = new THREE.CurvePath();
  for (let i = 1; i < pts.length; i++) path.add(new THREE.LineCurve3(new THREE.Vector3(...pts[i - 1]), new THREE.Vector3(...pts[i])));
  return new THREE.Mesh(new THREE.TubeGeometry(path, pts.length * 6, r, 6, false), M.cable);
}

// 局部坐标 → 世界朝向：局部 +X 沿 axis，局部 +Y 沿 up
function orient(g, axis, up) {
  const x = new THREE.Vector3(...axis).normalize();
  let y = new THREE.Vector3(...up).normalize();
  if (Math.abs(x.dot(y)) > 0.99) y = new THREE.Vector3(0, 0, 1);
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  y = new THREE.Vector3().crossVectors(z, x);
  g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  return g;
}

// ---------- 气动球阀 ----------
// PFA 阀体（中间是装球的球腔，两端是由壬螺母和接管）→ 支架 → 齿轮齿条式气动执行器（两端端盖、进气接头）→ 顶上的开关指示器。
// 通压缩空气，执行器把阀杆转 90°，里面的球跟着转到"开"或"关"。s：阀的大小（约等于阀体长度的一半多一点）
// 返回 { g, ind }：ind 是指示器，开 / 关时改它的颜色
export function ballValve(s, axis, up) {
  const body = mesh([
    G.ball(0.36 * s),
    G.cylX(0.3 * s, 0.9 * s),
    G.hexX(0.34 * s, 0.22 * s, -0.52 * s), G.hexX(0.34 * s, 0.22 * s, 0.52 * s),
    G.cylX(0.2 * s, 0.26 * s, -0.75 * s), G.cylX(0.2 * s, 0.26 * s, 0.75 * s),
    G.cylY(0.13 * s, 0.32 * s, 0, 0.46 * s),
  ], M.resin);
  const bracket = mesh([
    G.box(0.66 * s, 0.05 * s, 0.5 * s, 0, 0.64 * s),
    G.box(0.05 * s, 0.24 * s, 0.5 * s, -0.3 * s, 0.77 * s), G.box(0.05 * s, 0.24 * s, 0.5 * s, 0.3 * s, 0.77 * s),
  ], M.steel);
  const act = mesh([G.box(1.1 * s, 0.5 * s, 0.56 * s, 0, 1.13 * s), G.cylY(0.2 * s, 0.04 * s, 0, 1.4 * s)], M.actuator);
  const caps = mesh([
    G.box(0.07 * s, 0.54 * s, 0.6 * s, -0.585 * s, 1.13 * s), G.box(0.07 * s, 0.54 * s, 0.6 * s, 0.585 * s, 1.13 * s),
    G.cylZ(0.04 * s, 0.1 * s, -0.25 * s, 1.08 * s, 0.32 * s), G.cylZ(0.04 * s, 0.1 * s, 0.25 * s, 1.08 * s, 0.32 * s),
  ], M.dark);
  const ind = new THREE.Mesh(new THREE.SphereGeometry(0.17 * s, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.42 * s, 0), M.indicator);
  return { g: orient(grp(body, bracket, act, caps, ind), axis, up), ind };
}

// ---------- 兆声 ----------
// 振子：压电陶瓷贴在振板背面，装在槽底外侧；外面是不锈钢壳，侧面有高频电缆接头和冷却用的 N₂ 进出口（[US5534076] 的通用结构）。
// 原点在振板顶面中心；port：电缆接头的位置（局部坐标），side = +1 / −1 表示接头在 +X / −X 侧
export function megaTransducer(w, d, side = 1) {
  const plate = mesh([G.box(w, 0.005, d, 0, -0.0025)], M.mega);
  const shell = mesh([
    G.box(w * 0.94, 0.02, d * 0.94, 0, -0.015),
    G.box(w + 0.012, 0.004, d + 0.012, 0, -0.006),
  ], M.steel);
  const fit = mesh([
    G.cylX(0.007, 0.022, side * (w * 0.47 + 0.011), -0.015, 0), G.hexX(0.009, 0.008, side * (w * 0.47 + 0.02), -0.015, 0),
    G.cylX(0.004, 0.016, -side * (w * 0.47 + 0.008), -0.015, d * 0.25), G.cylX(0.004, 0.016, -side * (w * 0.47 + 0.008), -0.015, -d * 0.25),
  ], M.dark);
  return { g: grp(plate, shell, fit), port: [side * (w * 0.47 + 0.026), -0.015, 0] };
}

// 发生器：输出约 1 MHz 的高频电；前面板有显示屏（实时显示开 / 关）和指示灯，侧面有散热孔。前面朝 +Z
export function megaGenerator(w, h, d) {
  const scr = lcd(['兆声 OFF', ''], 256, 96);
  const cas = mesh([G.box(w, h, d)], M.panel);
  const front = mesh([
    G.box(w * 0.96, h * 0.92, 0.004, 0, 0, d / 2 + 0.002),
    ...[-1, 1].map(sx => G.cylY(0.004, h * 0.6, sx * w * 0.44, 0, d / 2 + 0.012)),
    ...[0, 1, 2, 3, 4].map(i => G.box(0.003, h * 0.6, d * 0.7, w / 2 + 0.001, 0, -d * 0.35 + i * d * 0.17)),
  ], M.dark);
  scr.mesh.scale.set(w * 0.62, h * 0.42, 1);
  scr.mesh.position.set(-w * 0.08, h * 0.12, d / 2 + 0.0045);
  const leds = mesh([0, 1, 2].map(i => G.cylZ(0.004, 0.004, -w * 0.3 + i * w * 0.12, -h * 0.28, d / 2 + 0.005)), M.green);
  const knob = mesh([G.cylZ(0.008, 0.008, w * 0.3, -h * 0.25, d / 2 + 0.006)], M.steel);
  return { g: grp(cas, front, scr.mesh, leds, knob), lcd: scr, back: [0, 0, -d / 2] };
}

// ---------- 液晶屏（画布贴图，可以实时改字） ----------
export function lcd(lines, W = 256, H = 128) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  let last = '';
  const set = ls => {
    const key = ls.join('\n');
    if (key === last) return;
    last = key;
    const x = c.getContext('2d');
    x.fillStyle = '#b9cfa6'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#18261a';
    const fs = Math.floor(H / (ls.length + 0.8));
    x.font = `bold ${fs}px ui-monospace, Menlo, Consolas, monospace`;
    x.textBaseline = 'middle';
    ls.forEach((t, i) => x.fillText(t, W * 0.06, H * (i + 0.9) / (ls.length + 0.8)));
    tex.needsUpdate = true;
  };
  set(lines);
  return { mesh: m, set };
}

// 显示仪表（比电阻 / 温度）：小方盒 + 液晶屏，前面朝 +Z，下面一根立柱。原点在立柱底部
export function meter(w = 0.07, h = 0.05, d = 0.03, post = 0.06) {
  const scr = lcd(['--', '--']);
  const box = mesh([G.box(w, h, d, 0, post + h / 2), G.cylY(0.006, post, 0, post / 2), G.box(0.03, 0.004, 0.03, 0, 0.002)], M.panel);
  const bezel = mesh([G.box(w * 0.9, h * 0.8, 0.003, 0, post + h / 2, d / 2 + 0.0015), G.cylY(0.005, 0.01, w * 0.32, post - 0.004, 0)], M.dark);
  scr.mesh.scale.set(w * 0.8, h * 0.62, 1);
  scr.mesh.position.set(0, post + h * 0.52, d / 2 + 0.0035);
  return { g: grp(box, bezel, scr.mesh), lcd: scr, top: [0, post + h, 0], cablePort: [w * 0.32, post - 0.009, 0] };
}

// ---------- 浸入式比电阻计 ----------
// PFA 护套的长杆，下端是同心的两个电极：中心电极 + 外面一圈筒状电极（[US6563329] 的结构），上端是接线头，电缆从侧面出。
// 原点在接线头顶面；杆往 −Y 伸 len
export function resistivityProbe(len) {
  const rod = mesh([G.cylY(0.007, len - 0.05, 0, -0.05 - (len - 0.05) / 2)], M.resin);
  const head = mesh([G.cylY(0.015, 0.045, 0, -0.0225), G.cylY(0.017, 0.006, 0, -0.003), G.cylX(0.005, 0.016, 0.02, -0.022, 0)], M.steel);
  const tip = mesh([
    G.cylY(0.0095, 0.04, 0, -len + 0.02, 0, 20),      // 外电极（筒）
    G.cylY(0.0035, 0.046, 0, -len + 0.017, 0, 12),    // 中心电极
  ], M.electrode);
  const ins = mesh([G.cylY(0.0098, 0.006, 0, -len + 0.043, 0, 20), G.cylY(0.006, 0.004, 0, -len + 0.002, 0, 16)], M.dark);
  return { g: grp(rod, head, tip, ins), cablePort: [0.028, -0.022, 0] };
}

// ---------- 测温探头（铂电阻 Pt100，PFA 包覆） ----------
// 细长护管伸进液体，上端弯过槽沿，接到接线盒。原点在弯头处；杆往 −Y 伸 len，接线盒在 +Z 方向 reach 处
export function rtdProbe(len, reach) {
  const r = 0.0045, b = 0.012;
  const sheath = mesh([
    G.cylY(r, len - b, 0, -b - (len - b) / 2),
    new THREE.TorusGeometry(b, r, 8, 10, Math.PI / 2).rotateY(Math.PI / 2).translate(0, -b, b),   // 弯头：从竖直向下转到朝 +Z
    G.cylZ(r, reach - b, 0, 0, b + (reach - b) / 2),
  ], M.resin);
  const tipCap = mesh([G.ball(r * 1.05, 0, -len, 0)], M.resin);
  const head = mesh([G.cylZ(0.011, 0.03, 0, 0, reach + 0.015), G.cylZ(0.013, 0.005, 0, 0, reach + 0.032), G.cylY(0.004, 0.014, 0, -0.016, reach + 0.015)], M.steel);
  return { g: grp(sheath, tipCap, head), cablePort: [0, -0.023, reach + 0.015] };
}

// 液位计（外槽用）：插在外槽里的电极杆 + 接线头。原点在接线头顶面
export function levelProbe(len) {
  return grp(mesh([G.cylY(0.005, len, 0, -0.03 - len / 2), G.cylY(0.005, len * 0.8, 0.014, -0.03 - len * 0.4)], M.resin),
    mesh([G.cylY(0.014, 0.03, 0.007, -0.015), G.box(0.036, 0.008, 0.02, 0.007, -0.03)], M.steel));
}

// ---------- 药液槽的循环线 ----------
// 磁力驱动泵：下面是 PFA 泵头（进出口沿 ±Z），上面是电机和风扇罩，底下有底座。原点在泵头中心
export function magPump() {
  const head = mesh([G.cylY(0.05, 0.05), G.cylZ(0.016, 0.03, 0, 0, 0.055), G.cylZ(0.016, 0.03, 0, 0, -0.055), G.cylY(0.054, 0.008, 0, 0.026)], M.resin);
  const motor = mesh([G.cylY(0.045, 0.11, 0, 0.09), G.cylY(0.04, 0.03, 0, 0.16)], M.pump);
  const fins = mesh([...Array(8)].map((_, i) => G.box(0.01, 0.09, 0.003, 0.048, 0.09, 0).rotateY(i * Math.PI / 4)), M.pump);   // 电机外壳的散热筋
  const base = mesh([G.box(0.13, 0.008, 0.1, 0, -0.06), G.cylY(0.008, 0.035, 0.05, -0.04, 0.035), G.cylY(0.008, 0.035, -0.05, -0.04, 0.035), G.cylY(0.008, 0.035, 0.05, -0.04, -0.035), G.cylY(0.008, 0.035, -0.05, -0.04, -0.035)], M.steel);
  const box = mesh([G.box(0.035, 0.03, 0.025, 0.05, 0.1, 0)], M.dark);
  return grp(head, motor, fins, base, box);
}

// 过滤器：PFA 外壳（罩着滤芯），上面是带进出口的头部和排气阀；下进上出。原点在外壳中心，总高 h
export function filterHousing(h) {
  const bowl = mesh([G.cylY(0.048, h * 0.8, 0, -h * 0.08), new THREE.SphereGeometry(0.048, 18, 12).scale(1, 0.4, 1).translate(0, -h * 0.48, 0)], M.filter);
  const head = mesh([G.cylY(0.056, h * 0.14, 0, h * 0.4), G.cylY(0.052, 0.012, 0, h * 0.31), G.cylY(0.01, 0.03, 0.03, h * 0.5)], M.resin);
  const vent = mesh([G.cylY(0.006, 0.02, 0.03, h * 0.53), G.cylX(0.004, 0.012, 0.038, h * 0.53)], M.dark);
  const bands = mesh([G.cylY(0.05, 0.006, 0, h * 0.1), G.cylY(0.05, 0.006, 0, -h * 0.25)], M.resin);
  return grp(bowl, head, vent, bands);
}

// 管道加热器：不锈钢外壳里是石英 / PFA 管，沿 X 方向过液；上面是接线盒和电线管。原点在中心
export function inlineHeater(len) {
  const shell = mesh([G.cylX(0.045, len * 0.82), ...[-1, 1].map(sx => G.cylX(0.05, 0.012, sx * len * 0.41))], M.heater);
  const ends = mesh([G.cylX(0.02, len * 0.1, -len * 0.46), G.cylX(0.02, len * 0.1, len * 0.46)], M.resin);
  const tb = mesh([G.box(0.06, 0.04, 0.05, 0, 0.06), G.cylY(0.008, 0.05, 0.02, 0.1)], M.dark);
  const fins = mesh([...Array(5)].map((_, i) => G.cylX(0.047, 0.004, -len * 0.3 + i * len * 0.15)), M.steel);
  return grp(shell, ends, tb, fins);
}

// ---------- 单槽的流量控制 ----------
// 下面是带浮子的玻璃管流量计，上面是流量调节阀（侧面一个旋钮）。竖着过液，原点在中心，总高 h
export function flowControl(h) {
  const blocks = mesh([G.box(0.034, 0.014, 0.034, 0, -h / 2 + 0.007), G.box(0.034, 0.014, 0.034, 0, h * 0.06), G.box(0.04, h * 0.3, 0.04, 0, h * 0.33)], M.resin);
  const glass = mesh([G.cylY(0.01, h * 0.42, 0, -h * 0.2)], M.glassTube);
  const flt = mesh([G.cylY(0.007, 0.008, 0, -h * 0.22, 0, 12)], M.dark);
  const knob = mesh([G.cylZ(0.004, 0.02, 0, h * 0.33, 0.03), G.cylZ(0.011, 0.01, 0, h * 0.33, 0.044, 12)], M.dark);
  const marks = mesh([0, 1, 2, 3].map(i => G.box(0.004, 0.0015, 0.002, 0.011, -h * 0.36 + i * h * 0.09, 0.0085)), M.dark);
  return grp(blocks, glass, flt, knob, marks);
}

// 混合块：一块 PFA，四角有螺栓。原点在中心
export function mixingBlock(w, h, d) {
  return grp(mesh([G.box(w, h, d)], M.resin),
    mesh([-1, 1].flatMap(sx => [-1, 1].map(sy => G.cylZ(0.004, 0.004, sx * (w / 2 - 0.008), sy * (h / 2 - 0.008), d / 2 + 0.002, 6))), M.steel));
}

// 淋浴喷嘴头：沿管子排的一排小喷嘴（朝下、略朝里）。n 个，间距 pitch，tilt：朝 −Z 还是 +Z 倾
export function nozzleRow(n, pitch, tilt) {
  const gs = [];
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * pitch;
    gs.push(new THREE.CylinderGeometry(0.004, 0.0065, 0.014, 10).rotateX(tilt * 0.6).translate(x, -0.012, tilt * 0.004));
  }
  return mesh(gs, M.resin);
}
