// 细模型（搭建路线.md 阶段 2）：看 build_wetbench.py 生成的 output/wetbench_detail.glb。
// 四组：药液槽、单槽、减压干燥槽、搬送。每组可以切"完整 / 剖切"、拉开爆炸图、显示液流箭头、让会动的部分动一下；点零件看说明。
// 零件信息都在 glb 的 extras 里（part_no / name_cn / group / material_spec / desc / ex / mv / mvg / cut / variant），这里不另写一份。
// 和跑批的那个场景共用同一个渲染器和画布：打开细模型时画这个场景，关掉时画回去。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export const ASM = [['cb', '药液槽'], ['ob', '单槽'], ['dr', '减压干燥槽'], ['tr', '搬送']];
const ASM_TITLE = { cb: '高温药液槽（SC1 槽，带兆声）', ob: '单槽', dr: '减压干燥槽', tr: '搬送：装载口、批量机械手、姿态变换、槽间搬送机械手' };
// 会动的部分：每组有哪些动作（按钮上的字）
export const MOVES = {
  cb: [['lifter', '升降器'], ['lid', '盖子']],
  ob: [['lifter', '升降器']],
  dr: [['lifter', '升降器'], ['lid', '密封盖']],
  tr: [['chuck', '夹爪'], ['door', 'FOUP 门']],
};
const VIEW = {
  cb: { p: [1.15, 1.55, 1.7], t: [0, 0.78, -0.02] }, ob: { p: [1.15, 1.55, 1.7], t: [0, 0.78, -0.02] },
  dr: { p: [1.35, 1.75, 2.05], t: [0, 0.98, -0.02] }, tr: { p: [1.0, 1.95, 2.9], t: [-0.3, 1.05, -0.05] },
};
const ease = p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

// glb 的字节：离线版嵌在页面里（base64）；开发时从 output/ 取
async function glbBytes() {
  const el = document.getElementById('glbData');
  if (el && el.textContent.length > 100) {
    const bin = atob(el.textContent.trim()), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  const r = await fetch('../output/wetbench_detail.glb');
  if (!r.ok) throw new Error('没找到 output/wetbench_detail.glb：先运行 python build_wetbench.py');
  return r.arrayBuffer();
}

export function createDetail({ canvas, environment, low }) {
  const scene = new THREE.Scene();
  scene.environment = environment;
  scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xe6eef6, 0x30363c, 0.55));
  const sun = new THREE.DirectionalLight(0xfff3e4, 2.0);
  sun.position.set(2.5, 5, 4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xcfdcff, 0.7);
  fill.position.set(-3, 2.5, -2);
  scene.add(fill);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(3.2, 48), new THREE.MeshStandardMaterial({ color: 0x9aa2aa, roughness: 0.9, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.03;
  scene.add(floor);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.02, 40);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.minDistance = 0.1;
  controls.maxDistance = 8;
  controls.enabled = false;

  const D = {
    scene, camera, controls, active: false, loaded: false, asm: 'cb', cut: false, flow: true, explode: 0,
    parts: {}, roots: {}, move: {}, moveTo: {}, selected: null, camAnim: null, error: null,
  };
  const all = [];   // 所有零件和液流：{ asm, pid, info, full, alt, cutMode, flow, base, ex, mv, mvg }

  function prepareMaterials(root) {
    root.traverse(m => {
      if (!m.isMesh) return;
      const src = m.material, name = src.name || '';
      if (name.startsWith('flow_')) {
        m.material = new THREE.MeshBasicMaterial({ color: src.color, name });
        m.userData.noPick = true;
        return;
      }
      m.material = src.clone();
      m.material.name = name;
      if (m.material.transparent) {
        m.material.depthWrite = false;
        m.renderOrder = name.startsWith('liq_') ? 1 : 2;      // 先画液体，再画外面的石英
        m.userData.seeThrough = true;
      }
      if (name === 'section') { m.material.polygonOffset = true; m.material.polygonOffsetFactor = -1; m.material.polygonOffsetUnits = -1; }
    });
  }

  async function load() {
    if (D.loaded || D.loading) return D.loading;
    D.loading = (async () => {
      const buf = await glbBytes();
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await new Promise((ok, bad) => loader.parse(buf, '', ok, bad));
      const byKey = {};
      for (const [id] of ASM) { D.roots[id] = new THREE.Group(); D.roots[id].visible = false; scene.add(D.roots[id]); D.parts[id] = []; }
      for (const node of [...gltf.scene.children]) {
        const u = node.userData;
        if (!u.asm || !D.roots[u.asm]) continue;
        prepareMaterials(node);
        D.roots[u.asm].add(node);
        const key = `${u.asm}/${u.pid}`;
        if (u.variant === 'cut') { (byKey[key] ||= {}).alt = node; continue; }
        const e = (byKey[key] ||= {});
        Object.assign(e, {
          asm: u.asm, pid: u.pid, full: node, cutMode: u.cut || 'same', flow: !!u.flow,
          base: node.position.clone(), ex: new THREE.Vector3(...(u.ex || [0, 0, 0])), mv: u.mv ? new THREE.Vector3(...u.mv) : null, mvg: u.mvg || null,
          info: u.flow ? null : { no: u.part_no, name: u.name_cn, grp: u.group, spec: u.material_spec, desc: u.desc },
        });
      }
      for (const key in byKey) {
        const e = byKey[key];
        if (!e.full) continue;
        all.push(e);
        for (const o of [e.full, e.alt]) if (o) o.traverse(m => { m.userData.entry = e; });
        if (e.info && e.info.name) D.parts[e.asm].push(e);
      }
      for (const id in D.parts) D.parts[id].sort((a, b) => a.info.no.localeCompare(b.info.no));
      D.loaded = true;
      apply();
      viewTo(D.asm, true);
    })().catch(err => { D.error = err; throw err; });
    return D.loading;
  }

  // 按现在的开关摆好每个零件：显示哪个版本、爆炸、动作
  function apply() {
    for (const [id] of ASM) if (D.roots[id]) D.roots[id].visible = id === D.asm;
    for (const e of all) {
      if (e.asm !== D.asm) continue;
      const show = !e.flow || D.flow;
      const useAlt = D.cut && e.cutMode === 'alt' && e.alt;
      e.full.visible = show && !(D.cut && e.cutMode !== 'same');
      if (e.alt) e.alt.visible = show && !!useAlt;
      const k = e.mv && e.mvg ? ease(D.move[`${e.asm}.${e.mvg}`] || 0) : 0;
      const x = e.base.x + e.ex.x * D.explode + (e.mv ? e.mv.x * k : 0), y = e.base.y + e.ex.y * D.explode + (e.mv ? e.mv.y * k : 0), z = e.base.z + e.ex.z * D.explode + (e.mv ? e.mv.z * k : 0);
      e.full.position.set(x, y, z);
      if (e.alt) e.alt.position.set(x, y, z);
    }
  }

  function viewTo(asm, jump = false) {
    const v = VIEW[asm], p1 = new THREE.Vector3(...v.p), t1 = new THREE.Vector3(...v.t);
    if (camera.aspect < 1) p1.sub(t1).multiplyScalar(1 + 1.0 * (1 - camera.aspect)).add(t1);
    if (jump) { camera.position.copy(p1); controls.target.copy(t1); D.camAnim = null; }
    else D.camAnim = { p0: camera.position.clone(), t0: controls.target.clone(), p1, t1, k: 0 };
  }

  // 选中的零件发蓝光（别和橙红的切面混了）
  function setHL(e, on) {
    if (!e) return;
    for (const o of [e.full, e.alt]) if (o) o.traverse(m => {
      if (m.isMesh && m.material.emissive && m.material.name !== 'section') { m.material.emissive.setHex(on ? 0x1e90ff : 0x000000); m.material.emissiveIntensity = on ? 0.6 : 1; }
    });
  }

  Object.assign(D, {
    load, apply, viewTo,
    title: () => ASM_TITLE[D.asm],
    setAsm(id) { D.asm = id; D.select(null); apply(); viewTo(id); },
    setCut(v) { D.cut = v; apply(); },
    setFlow(v) { D.flow = v; apply(); },
    setExplode(v) { D.explode = v; apply(); },
    toggleMove(g) { const key = `${D.asm}.${g}`; D.moveTo[key] = (D.moveTo[key] || 0) > 0.5 ? 0 : 1; return D.moveTo[key]; },
    moveState(g) { return D.moveTo[`${D.asm}.${g}`] || 0; },
    select(e) { setHL(D.selected, false); D.selected = e; setHL(e, true); return e; },
    find(asm, pid) { return all.find(e => e.asm === asm && e.pid === pid); },
    zoom() {
      const e = D.selected;
      if (!e) return;
      const o = D.cut && e.alt && e.cutMode === 'alt' ? e.alt : e.full;
      const bb = new THREE.Box3().setFromObject(o), c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3()).length();
      const dir = camera.position.clone().sub(controls.target).normalize();
      D.camAnim = { p0: camera.position.clone(), t0: controls.target.clone(), p1: c.clone().addScaledVector(dir, Math.max(0.4, size * 1.6) * Math.max(1, 1 / camera.aspect)), t1: c, k: 0 };
    },
    // 点选：先找不透明的零件；没点中再算透明的（石英槽、液体），不然槽里的东西永远点不到
    pick(ndc) {
      if (!D.loaded) return null;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObject(D.roots[D.asm], true).filter(h => {
        let o = h.object;
        if (!o.isMesh || o.userData.noPick) return false;
        for (; o; o = o.parent) if (!o.visible) return false;
        return h.object.userData.entry && h.object.userData.entry.info;
      });
      const solid = hits.find(h => !h.object.userData.seeThrough);
      const h = solid || hits[0];
      return h ? h.object.userData.entry : null;
    },
    resize(w, h) { camera.aspect = w / h; camera.updateProjectionMatrix(); },
    tick(dt) {
      let moving = false;
      for (const key in D.moveTo) {
        const cur = D.move[key] || 0, to = D.moveTo[key];
        if (cur !== to) { D.move[key] = to > cur ? Math.min(to, cur + dt / 1.6) : Math.max(to, cur - dt / 1.6); moving = true; }
      }
      if (moving) apply();
      if (D.camAnim) {
        const a = D.camAnim;
        a.k = Math.min(1, a.k + dt / 1.0);
        const k = ease(a.k);
        camera.position.lerpVectors(a.p0, a.p1, k);
        controls.target.lerpVectors(a.t0, a.t1, k);
        if (a.k >= 1) D.camAnim = null;
      }
      controls.update();
    },
  });
  viewTo('cb', true);
  if (low) sun.intensity = 1.8;
  return D;
}
