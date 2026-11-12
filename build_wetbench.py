#!/usr/bin/env python3
# 槽式清洗机 · Blender 细模型（搭建路线.md 阶段 2）
#
# 用代码生成四组细模型，导出 output/wetbench_detail.glb（打包时嵌进离线 html）：
#   cb  高温药液槽（SC1 槽，带兆声）   ob  单槽   dr  减压干燥槽   tr  搬送（装载口、批量机械手、姿态变换、槽间搬送机械手）
# 每个零件出"完整"和"剖切"两个版本：剖切 = 切掉 x > 0 且 z > 0 的那四分之一，切面涂剖面色。
#
# 用法（任选一种，几秒到十几秒出结果）：
#   pip install bpy   然后   python build_wetbench.py
#   或者              blender -b -P build_wetbench.py
#
# 公开边界：结构只按公开资料里的通用做法和 docs/管路.md 的功能设计来画，尺寸是几何推算的估计值（docs/规格.md），
# 不对应任何厂家的机型，也没有参考任何图纸。
#
# 约定：
#   坐标：米，+Y 向上（和网页一样）；x 沿晶圆排列方向，z 朝前。每组模型的槽中心在 x = 0、z = 0，槽内底 y = 0.60。
#   零件信息写在 glb 的 extras 里（VRToyBox 的约定）：part_no / name_cn / material_spec / desc / ex（爆炸方向，米），
#     另加 group（子系统）、asm（哪一组）、pid；剖切相关：cut = same / alt / hide，variant = cut。
#   会动的部分名字是 id__子名，extras 里 mvg（哪一组动作）和 mv（位移，米）。
#   金属度都不超过 0.55（以后导进 VR：那边没有反射探针）。

import math
import os
import sys

import bpy
import bmesh           # 要在 bpy 之后导入（pip 装的 bpy 里，bmesh 是 bpy 带进来的）
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, 'output')

# ---------- 尺寸（和 sim/params.js、docs/规格.md 一致；都是估计值） ----------
IL, IW, IH = 0.33, 0.35, 0.40      # 内槽 长（沿片排列）× 宽 × 深
T = 0.006                          # 石英壁厚
YB, YT = 0.60, 1.00                # 内槽底、槽口
WD, PITCH, NW = 0.300, 0.005, 50   # 晶圆直径、槽里的间距、片数
WY = YB + 0.06 + WD / 2            # 浸没时晶圆中心的高度
TRAVEL = 0.39                      # 升降器行程（浸没 ↔ 交接）
CUT_X, CUT_Z = 0.0009, 0.0009      # 剖切：去掉 x > CUT_X 且 z > CUT_Z 的部分

# ---------- 材质：名字 → (颜色, 金属度, 粗糙度, 不透明度) ----------
MATS = {
    'quartz': ((0.86, 0.94, 0.97), 0.0, 0.08, 0.22),     # 石英
    'clear': ((0.80, 0.88, 0.92), 0.0, 0.15, 0.20),      # 透明树脂（干燥槽的密封腔、FOUP）
    'pfa': ((0.92, 0.91, 0.86), 0.0, 0.5, 1),            # 耐药树脂 PFA / PTFE
    'pvc': ((0.74, 0.77, 0.80), 0.0, 0.6, 1),            # 机架、接液盘
    'sus': ((0.72, 0.75, 0.78), 0.5, 0.35, 1),           # 不锈钢
    'alu': ((0.82, 0.84, 0.86), 0.3, 0.45, 1),           # 执行器外壳
    'dark': ((0.22, 0.25, 0.29), 0.1, 0.6, 1),
    'rubber': ((0.06, 0.06, 0.07), 0.0, 0.8, 1),         # O 形圈
    'wafer': ((0.46, 0.49, 0.56), 0.55, 0.26, 1),
    'pump': ((0.30, 0.42, 0.55), 0.2, 0.5, 1),
    'heater': ((0.70, 0.39, 0.24), 0.2, 0.5, 1),
    'cart': ((0.97, 0.97, 0.94), 0.0, 0.9, 1),           # 滤芯
    'mega': ((0.58, 0.62, 0.67), 0.5, 0.3, 1),           # 兆声振板
    'piezo': ((0.80, 0.68, 0.30), 0.3, 0.5, 1),          # 压电陶瓷
    'screen': ((0.55, 0.68, 0.50), 0.0, 0.4, 1),
    'green': ((0.24, 0.61, 0.38), 0.0, 0.5, 1),
    'red': ((0.78, 0.27, 0.24), 0.0, 0.5, 1),
    'liq_sc1': ((0.49, 0.81, 0.58), 0.0, 0.05, 0.34),
    'liq_water': ((0.24, 0.62, 0.90), 0.0, 0.05, 0.30),
    'liq_ipa': ((0.56, 0.44, 0.85), 0.0, 0.05, 0.50),
    'section': ((0.88, 0.36, 0.20), 0.0, 0.7, 1),        # 剖面色
    # 液流箭头（网页里换成不受光照的纯色）
    'flow_chem': ((0.10, 0.62, 0.30), 0, 0.5, 1), 'flow_water': ((0.05, 0.45, 0.85), 0, 0.5, 1),
    'flow_gas': ((0.50, 0.56, 0.62), 0, 0.5, 1), 'flow_ipa': ((0.48, 0.30, 0.85), 0, 0.5, 1),
    'flow_drain': ((0.80, 0.50, 0.10), 0, 0.5, 1),
}
Y2Z = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))     # 网页坐标（Y 向上）→ Blender（Z 向上）
AXIS = {'x': Vector((1, 0, 0)), 'y': Vector((0, 1, 0)), 'z': Vector((0, 0, 1))}


def make_materials():
    out = {}
    for name, (rgb, metal, rough, alpha) in MATS.items():
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        b = m.node_tree.nodes.get('Principled BSDF')
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Metallic'].default_value = metal
        b.inputs['Roughness'].default_value = rough
        b.inputs['Alpha'].default_value = alpha
        if alpha < 1:
            if hasattr(m, 'surface_render_method'):
                m.surface_render_method = 'BLENDED'
            elif hasattr(m, 'blend_method'):
                m.blend_method = 'BLEND'
        out[name] = m
    return out


# ---------- 零件：往一个 bmesh 里堆基本体（坐标都是 Y 向上），最后转成一个 Blender 物体 ----------
def rot_to(d):
    """把局部 Z 轴转到方向 d。"""
    d = Vector(d).normalized()
    return Vector((0, 0, 1)).rotation_difference(d).to_matrix().to_4x4()


def frame(at, xaxis, yaxis):
    """局部坐标系：局部 +X 沿 xaxis，局部 +Y 沿 yaxis（阀门这类有朝向的部件用）。"""
    x = Vector(xaxis).normalized()
    y = Vector(yaxis).normalized()
    z = x.cross(y).normalized()
    y = z.cross(x)
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = Vector(at)
    return m


class Part:
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []
        self.F = Matrix.Identity(4)

    def _mi(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def _tag(self, verts, mat, smooth_axis=None, all_smooth=False):
        mi = self._mi(mat)
        faces = {f for v in verts for f in v.link_faces}
        for f in faces:
            f.material_index = mi
            if all_smooth:
                f.smooth = True
            elif smooth_axis is not None:
                f.normal_update()
                f.smooth = len(f.verts) == 4 and abs(f.normal.dot(smooth_axis)) < 0.9

    def box(self, sx, sy, sz, at, mat):
        m = self.F @ Matrix.Translation(Vector(at)) @ Matrix.Diagonal((sx, sy, sz, 1))
        r = bmesh.ops.create_cube(self.bm, size=1, matrix=m)
        self._tag(r['verts'], mat)
        return self

    def cyl(self, r, h, at, axis, mat, seg=20, r2=None):
        d = AXIS[axis] if isinstance(axis, str) else Vector(axis)
        m = self.F @ Matrix.Translation(Vector(at)) @ rot_to(d)
        o = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h, matrix=m)
        self._tag(o['verts'], mat, smooth_axis=(self.F.to_3x3() @ d.normalized()) if seg > 8 else None)
        return self

    def ball(self, r, at, mat, seg=14):
        m = self.F @ Matrix.Translation(Vector(at))
        o = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=max(6, seg // 2), radius=r, matrix=m)
        self._tag(o['verts'], mat, all_smooth=True)
        return self

    def ring(self, ro, ri, h, at, axis, mat, seg=24):
        """空心圆筒 / 法兰：外半径 ro、内半径 ri、高 h。"""
        d = AXIS[axis] if isinstance(axis, str) else Vector(axis)
        m = self.F @ Matrix.Translation(Vector(at)) @ rot_to(d)
        prof = [(ri, -h / 2), (ro, -h / 2), (ro, h / 2), (ri, h / 2)]
        rings = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            rings.append([self.bm.verts.new(m @ Vector((p[0] * math.cos(a), p[0] * math.sin(a), p[1]))) for p in prof])
        mi = self._mi(mat)
        for i in range(seg):
            a, b = rings[i], rings[(i + 1) % seg]
            for j in range(4):
                f = self.bm.faces.new((a[j], b[j], b[(j + 1) % 4], a[(j + 1) % 4]))
                f.material_index = mi
                f.smooth = j in (1, 3)
        return self

    def pipe(self, pts, r, mat, seg=12):
        """折线管：每段一个圆柱，拐弯处一个球。"""
        pts = [Vector(p) for p in pts]
        for a, b in zip(pts, pts[1:]):
            d = b - a
            if d.length > 1e-6:
                self.cyl(r, d.length, (a + b) / 2, d, mat, seg)
        for p in pts[1:-1]:
            self.ball(r, p, mat, seg)
        return self

    def valve(self, at, axis, up, s=0.04):
        """气动球阀：PFA 阀体 + 支架 + 气动执行器 + 顶上的开关指示器。axis：管子的方向；up：执行器朝哪边。"""
        keep = self.F
        self.F = keep @ frame(at, AXIS[axis] if isinstance(axis, str) else axis, AXIS[up] if isinstance(up, str) else up)
        self.ball(0.36 * s, (0, 0, 0), 'pfa', 10).cyl(0.26 * s, 1.5 * s, (0, 0, 0), 'x', 'pfa', 10)
        for sx in (-1, 1):
            self.cyl(0.34 * s, 0.22 * s, (sx * 0.52 * s, 0, 0), 'x', 'pfa', 6)                     # 由壬螺母
            self.box(0.07 * s, 0.54 * s, 0.6 * s, (sx * 0.585 * s, 1.13 * s, 0), 'dark')           # 执行器端盖
        self.cyl(0.13 * s, 0.50 * s, (0, 0.55 * s, 0), 'y', 'sus', 8)                              # 阀杆 + 支架
        self.box(1.1 * s, 0.5 * s, 0.56 * s, (0, 1.13 * s, 0), 'alu')
        self.cyl(0.17 * s, 0.08 * s, (0, 1.42 * s, 0), 'y', 'green', 10)                           # 开关指示器
        self.F = keep
        return self

    def arrow(self, pts, mat, r=0.006):
        """液流箭头：细管 + 箭头。"""
        pts = [Vector(p) for p in pts]
        d = (pts[-1] - pts[-2]).normalized()
        tip = pts[-1]
        pts[-1] = tip - d * r * 4
        self.pipe(pts, r, mat, 8)
        self.cyl(r * 2.4, r * 5, tip - d * r * 2.5, d, mat, 10, r2=0.0002)
        return self


# ---------- 登记零件 ----------
PARTS = []        # (物体, 要不要剖, 切面涂不涂剖面色)
STATE = {'asm': None, 'grp': None, 'n': 0, 'mats': None, 'col': None}
ASM_NAME = {'cb': '高温药液槽（SC1，带兆声）', 'ob': '单槽', 'dr': '减压干燥槽', 'tr': '搬送'}


def begin(asm):
    STATE.update(asm=asm, n=0)


def emit(p, pid, name_cn, group, desc, spec, ex=(0, 0, 0), mv=None, mvg=None, cut=True, cap=True, flow=False):
    asm = STATE['asm']
    if asm == 'tr':
        cut = False                    # 搬送那一组不剖
    # cut：True = 按整组的剖切位置切；(x, z) = 在这个零件自己的位置切四分之一（过滤器、加热器这类想看里面的）；False = 不切
    STATE['n'] += 1
    name = f'{asm}_{pid}'
    bmesh.ops.recalc_face_normals(p.bm, faces=p.bm.faces[:])
    bmesh.ops.transform(p.bm, matrix=Y2Z, verts=p.bm.verts[:])
    me = bpy.data.meshes.new(name)
    p.bm.to_mesh(me)
    p.bm.free()
    for m in p.mats:
        me.materials.append(STATE['mats'][m])
    ob = bpy.data.objects.new(name, me)
    STATE['col'].objects.link(ob)
    ob['asm'] = asm
    ob['pid'] = pid
    if flow:
        ob['flow'] = 1
    else:
        ob['part_no'] = f'{asm.upper()}-{STATE["n"]:02d}'
        ob['name_cn'] = name_cn
        ob['group'] = group
        ob['material_spec'] = spec
        ob['desc'] = desc
        ob['ex'] = [round(float(v), 4) for v in ex]
    if mv:
        ob['mv'] = [round(float(v), 4) for v in mv]
        ob['mvg'] = mvg
    PARTS.append((ob, cut, cap))
    return ob


def make_cuts():
    """剖切版：切掉 x > cx 且 z > cz 的四分之一（默认 cx = CUT_X、cz = CUT_Z）。没被切到的零件两个版本共用一份网格。"""
    cutter_me = bpy.data.meshes.new('cutter')
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1, matrix=Y2Z @ Matrix.Translation((2, 1, 2)) @ Matrix.Diagonal((4, 6, 4, 1)))
    bm.to_mesh(cutter_me)
    bm.free()
    cutter_me.materials.append(STATE['mats']['section'])
    cutter = bpy.data.objects.new('cutter', cutter_me)
    STATE['col'].objects.link(cutter)
    n_alt = 0
    for ob, cut, cap in PARTS:
        if not cut:
            ob['cut'] = 'same'
            continue
        cx, cz = (CUT_X, CUT_Z) if cut is True else cut
        cutter.location = (cx, -cz, 0)                     # Blender 坐标：x = x，y = −z，z = y
        vs = [v.co for v in ob.data.vertices]
        xs = [v.x for v in vs]
        zs = [-v.y for v in vs]
        if max(xs) <= cx + 1e-6 or max(zs) <= cz + 1e-6:
            ob['cut'] = 'same'
            continue
        if min(xs) >= cx - 1e-6 and min(zs) >= cz - 1e-6:
            ob['cut'] = 'hide'
            continue
        dup = ob.copy()
        dup.data = ob.data.copy()
        STATE['col'].objects.link(dup)
        mod = dup.modifiers.new('cut', 'BOOLEAN')
        mod.operation = 'DIFFERENCE'
        mod.object = cutter
        mod.solver = 'EXACT'
        mod.use_self = True             # 一个零件是好几个互相搭着的基本体：要让它先把自己理清楚，不然切出来会缺块
        if hasattr(mod, 'material_mode'):
            mod.material_mode = 'TRANSFER' if cap else 'INDEX'
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me2 = bpy.data.meshes.new_from_object(dup.evaluated_get(dg))
        dup.modifiers.clear()
        dup.data = me2
        if len(me2.vertices) == 0:
            bpy.data.objects.remove(dup)
            ob['cut'] = 'hide'
            continue
        dup.name = ob.name + '_CUT'
        dup['variant'] = 'cut'
        ob['cut'] = 'alt'
        n_alt += 1
    bpy.data.objects.remove(cutter)
    return n_alt


# ================= 共用：槽、晶圆、升降器、底座 =================
def tank_walls(p, L, W, y0, y1, t, mat, bottom=True, x_low=0.0):
    """开口的方槽：内部 L × W，从 y0（内底）到 y1（槽口）。x_low：两端（±x）的壁比两侧矮多少。"""
    h = y1 - y0
    if bottom:
        p.box(L + 2 * t, t, W + 2 * t, (0, y0 - t / 2, 0), mat)
    for s in (-1, 1):
        p.box(L + 2 * t, h, t, (0, y0 + h / 2, s * (W / 2 + t / 2)), mat)
        p.box(t, h - x_low, W, (s * (L / 2 + t / 2), y0 + (h - x_low) / 2, 0), mat)
    return p


def weir_teeth(p, length, at, axis, mat, tooth=0.012, h=0.010, t=T):
    """齿形溢流堰：槽口上一排齿，液体从齿缝里流出去。"""
    n = int(length / (2 * tooth))
    for i in range(n):
        o = (i - (n - 1) / 2) * 2 * tooth
        if axis == 'x':
            p.box(tooth, h, t, (at[0] + o, at[1] + h / 2, at[2]), mat)
        else:
            p.box(t, h, tooth, (at[0], at[1] + h / 2, at[2] + o), mat)
    return p


def wafer_stack(p, cx=0.0, cy=WY, n=NW, pitch=PITCH, axis='x', seg=24):
    for i in range(n):
        o = (i - (n - 1) / 2) * pitch
        at = (cx + o, cy, 0) if axis == 'x' else (cx, cy + o, 0)
        p.cyl(WD / 2, 0.0012, at, axis, 'wafer', seg)
    return p


def comb_rod(p, y, z, x0=-0.150, x1=0.140, r=0.0065, mat='pfa'):
    """带槽的导杆：一根杆 + 一圈一圈的齿，晶圆的边缘卡在齿缝里（5 mm 一片）。"""
    p.cyl(r, x1 - x0, ((x0 + x1) / 2, y, z), 'x', mat, 10)
    xm = (x0 + x1) / 2
    for k in range(-NW // 2, NW // 2 + 1):                 # 齿：薄片（方的，顶点少）
        p.box(0.0022, 2 * r + 0.007, 2 * r + 0.007, (xm + k * PITCH, y, z), mat)
    return p


def lifter(col_x, inside=False, travel=TRAVEL):
    """升降器：立柱在槽的一端外面，横臂越过槽沿，背板吊着三根带槽的导杆。会动的部分单独一个物体。"""
    asm = STATE['asm']
    yb = WY - 0.158                       # 底下那根导杆托住晶圆最低点
    ys = WY - 0.158 * math.cos(math.radians(40))
    zs = 0.158 * math.sin(math.radians(40))
    p = Part()
    comb_rod(p, yb, 0)
    comb_rod(p, ys, zs)
    comb_rod(p, ys, -zs)
    bx = -0.153                           # 背板（在批的一端，板面朝 x）
    p.box(0.008, 0.07, 2 * zs + 0.04, (bx, ys - 0.012, 0), 'pfa')
    p.box(0.008, 1.04 - ys, 0.05, (bx, (1.04 + ys) / 2, 0), 'pfa')
    p.box(0.006, 0.05, 2 * zs + 0.03, (0.143, ys - 0.012, 0), 'pfa')          # 另一端的小连板
    p.box(abs(col_x - bx) + 0.03, 0.026, 0.03, ((col_x + bx) / 2, 1.033, 0), 'pfa')   # 横臂
    if inside:      # 干燥槽：升降轴在密封腔里，穿过腔底
        p.cyl(0.011, 1.02 - 0.22, (col_x, (1.02 + 0.22) / 2, 0), 'y', 'sus', 14)
    else:           # 立柱上的滑块
        p.box(0.085, 0.10, 0.085, (col_x, 1.033, 0), 'alu')
    emit(p, 'lifter__lifter', '升降器（带槽的导杆）', '升降器',
         '每个槽自己的升降器：在交接位置从槽间搬送机械手手里接过整批晶圆，降下去浸进液体，处理完再提上来。三根带槽的导杆托住 50 片晶圆的下边缘，'
         '每片卡在一道 5 mm 间距的齿缝里，竖着排成一排；背板只在批的一端，另一端敞开，液流能穿过片间。慢速提拉干燥时也是它在提。',
         'PFA 包覆 / PEEK（接液部分）；滑块是铝', ex=(-0.10, 0.42, 0), mv=(0, travel, 0), mvg='lifter')
    p = Part()
    wafer_stack(p)
    emit(p, 'wafers__lifter', '晶圆（50 片）', '晶圆',
         '300 mm 晶圆 50 片，两盒合成一批，间距 5 mm（半间距）。竖着放：液流从槽底往上穿过片间，从槽口溢流出去；提出液面时水顺着往下流。片间缝隙只有约 4.2 mm。',
         '硅', ex=(0, 0.75, 0), mv=(0, travel, 0), mvg='lifter')
    if inside:
        p = Part()
        p.cyl(0.03, 0.012, (col_x, 0.494, 0), 'y', 'sus', 18)
        for i in range(7):                # 波纹管
            p.cyl(0.026 if i % 2 else 0.020, 0.018, (col_x, 0.479 - i * 0.018, 0), 'y', 'sus', 16)
        p.cyl(0.03, 0.012, (col_x, 0.35, 0), 'y', 'sus', 18)
        p.box(0.07, 0.24, 0.07, (col_x, 0.20, 0), 'alu')
        p.box(0.09, 0.02, 0.09, (col_x, 0.08, 0), 'dark')
        emit(p, 'lifter_drive', '升降轴的波纹管密封 + 驱动', '升降器',
             '升降轴要穿过密封腔的底：轴外面套一段金属波纹管，轴上下动的时候波纹管跟着伸缩，腔里照样密封（减压、IPA 蒸气都漏不出去）。下面是驱动（电机 + 丝杠），在腔外面。'
             '这是真空设备里通用的做法（示意）。', '不锈钢波纹管；驱动外壳铝', ex=(-0.12, -0.15, 0))
    else:
        p = Part()
        p.box(0.07, 1.42, 0.07, (col_x, 0.07 + 0.71, 0), 'pvc')
        p.box(0.012, 1.30, 0.03, (col_x + 0.041, 0.80, 0), 'sus')               # 导轨
        p.box(0.10, 0.14, 0.10, (col_x, 1.56, 0), 'dark')                       # 电机
        emit(p, 'lifter_col', '升降器立柱（导轨 + 驱动）', '升降器',
             '立柱在槽的一端外面，不泡在液体里。里面是丝杠和导轨，顶上是电机。快速升降约 0.1 m/s；干燥槽的慢速提拉只有 1 mm/s 左右，要走得很稳，不能抖。',
             '外壳耐药树脂；导轨不锈钢', ex=(-0.22, 0, 0))


def base(L=0.74, W=0.86, posts=None, top=0.585):
    """接液盘 + 机架立柱。"""
    p = Part()
    zc = -0.03
    p.box(L, 0.012, W, (0, 0.046, zc), 'pvc')
    for s in (-1, 1):
        p.box(L, 0.04, 0.012, (0, 0.066, zc + s * (W / 2 - 0.006)), 'pvc')
        p.box(0.012, 0.04, W, (s * (L / 2 - 0.006), 0.066, zc), 'pvc')
    p.cyl(0.012, 0.03, (L / 2 - 0.05, 0.065, zc + W / 2 - 0.05), 'y', 'dark', 10)     # 漏液传感器
    emit(p, 'pan', '接液盘 + 漏液传感器', '机架',
         '槽和管路下面的托盘。接头松了、管子裂了，漏出来的药液先落在这里；角上的漏液传感器一碰到液体就报警、停止供液。', '耐药树脂（PVC / PP）', ex=(0, -0.12, 0), cut=False)
    if posts:
        p = Part()
        (x0, x1), (z0, z1) = posts
        for x in (x0, x1):
            for z in (z0, z1):
                p.box(0.03, top - 0.052, 0.03, (x, (top + 0.052) / 2, z), 'pvc')
        for z in (z0, z1):
            p.box(x1 - x0 + 0.03, 0.03, 0.03, ((x0 + x1) / 2, top - 0.015, z), 'pvc')
        for x in (x0, x1):
            p.box(0.03, 0.03, z1 - z0 - 0.03, (x, top - 0.015, (z0 + z1) / 2), 'pvc')
        emit(p, 'frame', '机架', '机架', '托住槽体的架子。泵、过滤器、阀门都装在槽下面的这个空间里，前面有可以打开的面板，方便维护。', '耐药树脂包覆的钢架', ex=(0, -0.05, 0.02), cut=False)


def inlet_tubes(p, mat='pfa', n=11):
    """槽底两条进液管：沿片排列方向，一排小孔斜着朝里朝上喷。"""
    for s in (-1, 1):
        z = s * 0.150
        p.cyl(0.010, 0.31, (0, YB + 0.016, z), 'x', mat, 14)
        for i in range(n):
            x = (i - (n - 1) / 2) * 0.027
            d = Vector((0, 0.7, -s * 0.7))
            p.cyl(0.0035, 0.012, Vector((x, YB + 0.016, z)) + d.normalized() * 0.012, d, mat, 8)
    p.cyl(0.010, 0.30, (-0.150, YB + 0.016, 0), 'z', mat, 14)          # 两条管在一端连起来
    return p


def megasonic(pid='mega'):
    p = Part()
    y = YB - T
    p.box(0.26, 0.004, 0.24, (0, y - 0.002, 0), 'mega')                 # 振板
    for ix in range(4):
        for iz in range(3):
            p.box(0.05, 0.006, 0.06, (-0.09 + ix * 0.06, y - 0.007, -0.07 + iz * 0.07), 'piezo')     # 压电陶瓷片
    p.box(0.275, 0.004, 0.255, (0, y - 0.0125, 0), 'sus')
    for s in (-1, 1):
        p.box(0.275, 0.022, 0.004, (0, y - 0.0125 - 0.009, s * 0.1255), 'sus')
        p.box(0.004, 0.022, 0.247, (s * 0.1355, y - 0.0125 - 0.009, 0), 'sus')
    p.box(0.275, 0.003, 0.255, (0, y - 0.034, 0), 'sus')
    p.cyl(0.008, 0.03, (-0.152, y - 0.022, 0), 'x', 'dark', 10)          # 高频电缆接头
    emit(p, pid, '兆声振子（振板 + 压电陶瓷）', '兆声',
         '贴在槽底外侧。压电陶瓷片粘在振板背面，通上约 1 MHz 的高频电就振动，声波穿过石英槽底传进液体，往上扫过晶圆表面，帮忙把小颗粒冲走。'
         '频率比超声清洗（20 ~ 200 kHz）高得多，空化弱、尺度小，对细图形温和一些；功率太大还是会伤图形。液位不够不能开：振板没有液体带走热量会烧坏（联锁）。'
         '剖开能看到背面排着的压电陶瓷片。', '振板不锈钢 / 石英；压电陶瓷 PZT；外壳不锈钢', ex=(0, -0.16, 0.06))


def mega_gen(at, pid='megagen'):
    p = Part()
    x, y, z = at
    p.box(0.14, 0.10, 0.12, at, 'pvc')
    p.box(0.13, 0.09, 0.004, (x, y, z + 0.062), 'dark')
    p.box(0.07, 0.035, 0.002, (x - 0.02, y + 0.015, z + 0.065), 'screen')
    for i in range(3):
        p.cyl(0.004, 0.004, (x - 0.045 + i * 0.016, y - 0.028, z + 0.066), 'z', 'green', 8)
    p.pipe([(x - 0.07, y, z), (-0.166, y, z), (-0.166, YB - T - 0.022, z), (-0.166, YB - T - 0.022, 0), (-0.156, YB - T - 0.022, 0)], 0.004, 'rubber', 8)
    emit(p, pid, '兆声发生器 + 高频电缆', '兆声', '把电变成约 1 MHz 的高频电，经同轴电缆送到槽底的振子。面板上能设功率、看开关状态。发生器不耐药液，装在槽下面干的地方。',
         '外壳树脂 / 金属；同轴电缆', ex=(-0.10, -0.10, 0.20), cut=False)


def flows(pid, items):
    """液流箭头：items = [(材质, 折线点)]。"""
    p = Part()
    for mat, pts in items:
        p.arrow(pts, mat)
    emit(p, pid, '', '', '', '', flow=True, cap=False)


def upflow_arrows(mat):
    """从槽底进液管往上、穿过片间。"""
    out = []
    for x in (-0.09, 0.0, 0.09):
        for s in (-1, 1):
            out.append((mat, [(x, YB + 0.03, s * 0.135), (x, YB + 0.10, s * 0.07), (x, YT - 0.05, s * 0.07)]))
    return out


# ================= 高温药液槽（SC1，带兆声） =================
def build_chembath():
    begin('cb')
    G = '药液槽'
    oy0, ow = YT - 0.14, 0.055                      # 外槽：槽口外面一圈，底在 oy0
    ox, oz = IL / 2 + T + ow / 2, IW / 2 + T + ow / 2   # 外槽通道的中心线

    p = Part()
    tank_walls(p, IL, IW, YB, YT, T, 'quartz')
    emit(p, 'inner', '内槽', G,
         '晶圆泡在这里。药液从槽底的进液管进来，往上穿过片间，从四周的槽口溢流到外槽：液面一直在更新，浮到表面的颗粒被溢流带走，不会在提出晶圆时又粘回去。'
         '一个槽只用一种药（这里是 SC1），药液循环、过滤、保温，反复用。', '石英', ex=(0, 0, 0))
    p = Part()
    for s in (-1, 1):
        weir_teeth(p, IL, (0, YT, s * (IW / 2 + T / 2)), 'x', 'quartz')
        weir_teeth(p, IW, (s * (IL / 2 + T / 2), YT, 0), 'z', 'quartz')
    emit(p, 'weir', '溢流堰（齿形）', G,
         '内槽槽口上的一圈齿。液体从齿缝里流出去：槽装得稍微不水平，也是四周都在流，不会只从低的一边流。四周都溢流，槽里的上升流才均匀。（通用结构，示意）', '石英', ex=(0, 0.10, 0))
    p = Part()
    for s in (-1, 1):
        p.box(IL + 2 * T + 2 * ow, T, ow, (0, oy0 - T / 2, s * oz), 'quartz')
        p.box(ow, T, IW + 2 * T, (s * ox, oy0 - T / 2, 0), 'quartz')
        p.box(IL + 2 * ow + 4 * T, 0.16 + T, T, (0, oy0 - T + (0.16 + T) / 2, s * (IW / 2 + T + ow + T / 2)), 'quartz')
        p.box(T, 0.16 + T, IW + 2 * T + 2 * ow, (s * (IL / 2 + T + ow + T / 2), oy0 - T + (0.16 + T) / 2, 0), 'quartz')
    emit(p, 'outer', '外槽', G,
         '围在内槽槽口外面的一圈槽，接住溢流出来的药液，给循环泵当缓冲。外槽的液位比内槽低，有落差才溢得出来。'
         '外槽液位太低时泵会吸进空气，所以液位低就停泵（联锁）。', '石英', ex=(0, 0.20, 0))
    p = Part()
    p.box(IL - 0.001, IH - 0.001, IW - 0.001, (0, YB + IH / 2, 0), 'liq_sc1')
    emit(p, 'liq', '内槽的药液（SC1）', '液体', 'NH₄OH + H₂O₂ + 水，约 75 °C。H₂O₂ 氧化表面，NH₄OH 慢慢溶掉氧化层，把颗粒从底下掏松；碱性下颗粒和表面都带负电，互相排斥。', 'SC1', cap=False, ex=(0, 0, 0))
    p = Part()
    for s in (-1, 1):
        p.box(IL + 2 * T + 2 * ow - 0.001, 0.07, ow - 0.001, (0, oy0 + 0.035, s * oz), 'liq_sc1')
        p.box(ow - 0.001, 0.07, IW + 2 * T - 0.001, (s * ox, oy0 + 0.035, 0), 'liq_sc1')
    emit(p, 'liq_out', '外槽的药液', '液体', '从内槽溢流过来的药液，等着被循环泵抽走。', 'SC1', cap=False, ex=(0, 0.20, 0))

    p = Part()
    inlet_tubes(p)
    emit(p, 'inlet', '槽底进液管（带喷孔）', G,
         '内槽底的两条管，沿着晶圆排列的方向。循环回来的药液从管上的一排小孔斜着喷出来，汇成往上的流动，穿过片间。'
         '两条管贴着槽底的两边，把中间让给兆声振板：声波要从槽底中间直着往上走。', 'PFA', ex=(0, -0.05, 0))
    megasonic()
    mega_gen((0.0, 0.102, 0.30))

    # 循环线：外槽 → 泵 → 加热器 → 过滤器 → 内槽底
    px, pz = -ox, 0.10
    p = Part()
    p.cyl(0.055, 0.05, (px, 0.17, pz), 'z', 'pfa', 20)                       # 泵头
    p.cyl(0.020, 0.04, (px, 0.17, pz + 0.045), 'z', 'pfa', 12)               # 吸入口（轴向）
    p.cyl(0.018, 0.05, (px + 0.035, 0.225, pz), 'y', 'pfa', 12)              # 排出口（朝上）
    p.cyl(0.048, 0.02, (px, 0.17, pz - 0.035), 'z', 'sus', 20)               # 隔离套（磁力耦合）
    p.cyl(0.05, 0.13, (px, 0.17, pz - 0.11), 'z', 'pump', 20)                # 电机
    for i in range(8):
        a = i * math.pi / 4
        p.box(0.008, 0.008, 0.11, (px + 0.053 * math.cos(a), 0.17 + 0.053 * math.sin(a), pz - 0.11), 'pump')
    p.cyl(0.044, 0.03, (px, 0.17, pz - 0.19), 'z', 'dark', 16)               # 风扇罩
    p.box(0.13, 0.012, 0.22, (px, 0.104, pz - 0.07), 'sus')
    emit(p, 'pump', '循环泵（磁力驱动）', '循环线',
         '一直在转：把外槽的药液抽出来，经加热器、过滤器打回内槽底。磁力驱动：电机隔着一层隔离套用磁铁带动泵里的叶轮，药液碰不到轴封，不漏、不长颗粒。'
         '放在循环线最前面：吸入侧没有阻力件，热药液不容易汽蚀。', '接液部分 PFA；电机外壳铝', ex=(-0.20, -0.02, 0.10))
    p = Part()
    hx, hy, hz = -0.03, 0.17, -0.13
    p.ring(0.047, 0.040, 0.26, (hx, hy, hz), 'x', 'heater', 22)              # 外壳
    for s in (-1, 1):
        p.ring(0.052, 0.020, 0.012, (hx + s * 0.136, hy, hz), 'x', 'sus', 22)
        p.cyl(0.020, 0.05, (hx + s * 0.165, hy, hz), 'x', 'pfa', 12)
    p.box(0.06, 0.04, 0.05, (hx - 0.06, hy + 0.065, hz), 'dark')
    emit(p, 'heater', '管道加热器 · 外壳', '循环线',
         '药液从里面的管子流过，被加热到设定温度（SC1 约 75 °C）。泵停了它必须停：没有液体流过，热量带不走，会空烧（联锁）；另有一个独立的过温开关。剖开能看到里面的过液管和加热元件。',
         '外壳不锈钢（不接液）', ex=(0, -0.04, -0.22), cut=(hx + 0.02, hz))
    p = Part()
    p.ring(0.019, 0.015, 0.25, (hx, hy, hz), 'x', 'quartz', 16)              # 过液的管
    for i in range(9):
        p.ring(0.034, 0.022, 0.012, (hx - 0.10 + i * 0.025, hy, hz), 'x', 'heater', 16)     # 加热元件（示意）
    emit(p, 'heater_core', '管道加热器 · 过液管和加热元件', '循环线',
         '中间是过液的管（石英或 PFA，药液只碰到它），外面套着加热元件。热量隔着管壁传给药液：加热元件不接触药液，不会被腐蚀，也不会往药液里掉金属。', '过液管石英 / PFA；加热元件示意', ex=(0, -0.04, -0.40), cut=False)
    p = Part()
    fx, fz = ox, -0.10
    p.ring(0.050, 0.044, 0.24, (fx, 0.32, fz), 'y', 'pfa', 22)               # 外壳（筒）
    p.cyl(0.050, 0.008, (fx, 0.196, fz), 'y', 'pfa', 22)
    p.ring(0.058, 0.020, 0.045, (fx, 0.4625, fz), 'y', 'pfa', 22)            # 头部
    p.cyl(0.058, 0.006, (fx, 0.488, fz), 'y', 'pfa', 22)
    p.cyl(0.016, 0.03, (fx, 0.185, fz), 'y', 'pfa', 12)                      # 下进
    p.cyl(0.016, 0.04, (fx - 0.07, 0.4625, fz), 'x', 'pfa', 12)              # 侧出
    p.cyl(0.008, 0.03, (fx, 0.50, fz), 'y', 'pfa', 10)                       # 顶部排气口
    emit(p, 'filter', '过滤器 · 外壳', '循环线',
         '药液从下面进来，从外往里穿过滤芯，干净的从头部侧面出去。放在循环线最后：泵和加热器掉出来的颗粒也一起拦住。顶上是排气口：换液后刚开泵时，把壳里的空气顶回外槽。剖开能看到里面的滤芯。',
         'PFA', ex=(0.22, -0.02, -0.10), cut=(fx, fz))
    p = Part()
    p.ring(0.036, 0.016, 0.20, (fx, 0.325, fz), 'y', 'cart', 22)
    for i in range(12):
        a = i * math.pi / 6
        p.box(0.006, 0.20, 0.006, (fx + 0.037 * math.cos(a), 0.325, fz + 0.037 * math.sin(a)), 'cart')
    p.cyl(0.036, 0.008, (fx, 0.221, fz), 'y', 'pfa', 22)
    emit(p, 'cart', '滤芯', '循环线',
         '打褶的滤膜卷成筒，孔径几十纳米。颗粒被拦在膜上，越积越多，过滤器前后的压差慢慢升高：压差到了上限就要换滤芯（消耗件）。滤芯里憋着气泡的地方不过液，所以要排气。',
         'PTFE 滤膜 + PFA 骨架', ex=(0.22, 0.30, -0.10), cut=False)
    p = Part()
    p.pipe([(px, oy0 - T, 0.19), (px, 0.17, 0.19), (px, 0.17, pz + 0.065)], 0.016, 'pfa')                       # 外槽 → 泵
    p.pipe([(px + 0.035, 0.25, pz), (px + 0.035, 0.29, pz), (px + 0.035, 0.29, hz), (hx - 0.215, 0.29, hz), (hx - 0.215, hy, hz), (hx - 0.19, hy, hz)], 0.014, 'pfa')   # 泵 → 加热器
    p.pipe([(hx + 0.19, hy, hz), (fx, hy, hz), (fx, hy, fz), (fx, 0.172, fz)], 0.014, 'pfa')                    # 加热器 → 过滤器
    p.pipe([(fx - 0.09, 0.4625, fz), (0.105, 0.4625, fz), (0.105, 0.535, fz)], 0.014, 'pfa')                    # 过滤器 → 回流集管
    p.pipe([(0.105, 0.535, -0.150), (0.105, 0.535, 0.150)], 0.014, 'pfa')
    for s in (-1, 1):
        p.pipe([(0.105, 0.535, s * 0.150), (0.150, 0.535, s * 0.150), (0.150, YB + 0.016, s * 0.150)], 0.012, 'pfa')
    emit(p, 'pipe_circ', '循环管路', '循环线',
         '外槽底 → 循环泵 → 加热器 → 过滤器 → 分成两路，穿过内槽底接到两条进液管。顺序是公开专利里常见的（docs/管路.md 第 3 节）。', 'PFA 管', ex=(0, -0.10, 0.05))
    p = Part()
    p.pipe([(fx, 0.515, fz), (fx, 0.60, fz)], 0.008, 'pfa')
    p.valve((fx, 0.64, fz), 'y', 'x', 0.035)
    p.pipe([(fx, 0.68, fz), (fx, oy0 - T, fz)], 0.008, 'pfa')
    emit(p, 'vent', '过滤器排气阀 V6', '循环线', '换液后刚开泵时开几秒：过滤器壳里的空气被顶上来，经这根管回到外槽。平时关着。', 'PFA 气动阀', ex=(0.26, 0.05, -0.12))

    # 供液（从上方进内槽）、排液
    p = Part()
    for i, x in enumerate((0.03, 0.08, 0.13)):
        p.pipe([(x, 1.045, -0.47), (x, 1.045, -0.40)], 0.008, 'pfa')
        p.valve((x, 1.045, -0.36), 'z', 'y', 0.035)
        p.pipe([(x, 1.045, -0.32), (x, 1.045, -0.150), (x, 1.022, -0.150)], 0.008, 'pfa')
    emit(p, 'supply', '供液阀 V1～V3 和供液管', '供液 / 排液',
         'DIW、NH₄OH、H₂O₂ 三路，从后面过来，越过槽沿，从上方落进内槽。换液时按配比依次补进去（建浴）；以后按浓度补液也走这里（H₂O₂ 会分解、NH₃ 会挥发，阶段 3）。跑批时都关着。',
         'PFA 管 + 气动阀', ex=(0, 0.16, -0.16))
    p = Part()
    p.pipe([(-0.10, YB - T, 0.158), (-0.10, 0.45, 0.158)], 0.012, 'pfa')                                        # 内槽排液（前左角）
    p.valve((-0.10, 0.41, 0.158), 'y', 'z', 0.04)
    p.pipe([(-0.10, 0.37, 0.158), (-0.10, 0.092, 0.158), (-0.10, 0.092, -0.40)], 0.012, 'pfa')
    p.pipe([(-ox, oy0 - T, -0.19), (-ox, 0.56, -0.19)], 0.012, 'pfa')                                           # 外槽排液（后左角）
    p.valve((-ox, 0.52, -0.19), 'y', 'x', 0.04)
    p.pipe([(-ox, 0.48, -0.19), (-ox, 0.092, -0.19), (-ox, 0.092, -0.40)], 0.012, 'pfa')
    p.cyl(0.017, 0.60, (0.0, 0.092, -0.40), 'x', 'pfa', 14)
    emit(p, 'drain', '排液阀 V4、V5 和排液管', '供液 / 排液',
         '换液时排掉旧药液：内槽一个、外槽一个，汇到后面的排液总管（SC1 走碱排液）。排液前要先停加热器和泵。跑批时关着。', 'PFA 管 + 气动阀', ex=(-0.06, -0.12, 0.0))

    # 盖子、传感器
    for s, nm in ((-1, 'L'), (1, 'R')):
        p = Part()
        p.box(0.262, 0.010, 0.52, (s * 0.133, 1.075, 0), 'clear')
        p.box(0.02, 0.022, 0.20, (s * 0.20, 1.091, 0), 'pfa')
        emit(p, f'lid__{nm}', f'盖子（{"左" if s < 0 else "右"}半）', G,
             '没有晶圆进出时盖着：挡住药液蒸气（SC1 里的氨水、H₂O₂ 都在往外跑），少散热，也不让上面掉东西进去。升降器要上下时才向两边滑开。', '透明耐药树脂', ex=(s * 0.16, 0.30, 0),
             mv=(s * 0.27, 0, 0), mvg='lid')
    p = Part()
    for s in (-1, 1):
        p.box(0.86, 0.02, 0.02, (0, 1.060, s * 0.275), 'pvc')
        for x in (-0.19, 0.19):
            p.box(0.02, 1.050 - 0.052, 0.02, (x, (1.050 + 0.052) / 2, s * 0.275), 'pvc')
    emit(p, 'lid_rail', '盖子的滑轨', G, '两片盖子沿着它向两边滑开。', '耐药树脂', ex=(0, 0.25, 0), cut=False)
    p = Part()
    x, z = IL / 2 - 0.03, IW / 2 - 0.02                                    # 测温探头：前右角，上端弯过槽沿
    p.pipe([(x, YB + 0.10, z), (x, 1.035, z), (x, 1.035, z + 0.10)], 0.0045, 'pfa', 10)
    p.cyl(0.011, 0.03, (x, 1.035, z + 0.115), 'z', 'sus', 12)
    x2, z2 = -ox, -0.10                                                    # 外槽液位计
    p.cyl(0.005, 0.15, (x2, oy0 + 0.085, z2), 'y', 'pfa', 10)
    p.cyl(0.005, 0.11, (x2 + 0.014, oy0 + 0.105, z2), 'y', 'pfa', 10)
    p.cyl(0.014, 0.03, (x2 + 0.007, oy0 + 0.175, z2), 'y', 'sus', 12)
    emit(p, 'sensors', '测温探头 + 外槽液位计', '仪表',
         '测温探头（Pt100 铂电阻，PFA 包覆）伸进内槽，控温用。外槽里插着液位计：外槽液位低，泵要停。两样都是接触药液的，所以外面包着 PFA。', 'PFA 包覆', ex=(0.10, 0.22, 0.10))

    base(posts=((-0.19, 0.19), (-0.21, 0.21)))
    lifter(-0.30)

    flows('flow_main', upflow_arrows('flow_chem') + [
        ('flow_chem', [(0.10, YT - 0.02, 0.12), (0.10, YT + 0.03, 0.17), (0.10, YT - 0.05, oz)]),           # 溢流到外槽
        ('flow_chem', [(-0.10, YT - 0.02, -0.12), (-0.10, YT + 0.03, -0.17), (-0.10, YT - 0.05, -oz)]),
        ('flow_chem', [(-0.12, YT - 0.02, 0.0), (-0.17, YT + 0.03, 0.0), (-ox, YT - 0.05, 0.0)]),
        ('flow_chem', [(px + 0.03, 0.80, 0.19), (px + 0.03, 0.30, 0.19)]),                                  # 下到泵
        ('flow_chem', [(-0.15, 0.33, hz), (0.09, 0.33, hz)]),                                               # 过加热器
        ('flow_chem', [(fx + 0.08, 0.22, fz), (fx + 0.08, 0.44, fz)]),                                      # 过滤器里往上
        ('flow_chem', [(0.105, 0.50, -0.05), (0.105, 0.57, -0.05)]),
    ])


# ================= 单槽 =================
PAN_L, PAN_W, PAN_Y, PAN_T = 0.50, 0.41, 0.50, 0.95      # 接液槽：内部长、宽，底、口


def build_onebath():
    begin('ob')
    G = '单槽'
    p = Part()
    tank_walls(p, IL, IW, YB, YT + 0.014, T, 'quartz', x_low=0.014)
    emit(p, 'tank', '槽体', G,
         '石英槽。低浓度的药液处理和纯水冲洗都在这一个槽里做：水从槽底进，从两端的槽口溢流（上流）。同一个槽里换液，处理和冲洗之间晶圆不出液面。每批现配，用完排掉。'
         '两侧的壁比两端高一点：水只从两端溢出去。', '石英', ex=(0, 0, 0))
    p = Part()
    for s in (-1, 1):
        weir_teeth(p, IW, (s * (IL / 2 + T / 2), YT, 0), 'z', 'quartz')
    emit(p, 'weir', '溢流口（两端的齿形堰）', G, '槽的两端各一排齿，水从齿缝里溢出去，落进接液槽。齿形让整条边都在流，流动均匀。（通用结构，示意）', '石英', ex=(0, 0.10, 0))
    p = Part()
    tank_walls(p, PAN_L, PAN_W, PAN_Y, PAN_T, T, 'quartz')
    for x in (-0.12, 0.12):
        for z in (-0.13, 0.13):
            p.box(0.04, YB - T - PAN_Y, 0.04, (x, (YB - T + PAN_Y) / 2, z), 'pfa')      # 垫脚
    emit(p, 'pan', '接液槽', G,
         '把槽围起来的外槽。两端溢流的水、快排排出来的水都落到这里，再从一根排液管出去，按液体切到酸排液 / 碱排液 / DIW 回收。进多少出多少，自己不存液；'
         '所以装了液位开关：排液没开、堵了，液面一涨就报警。', '石英 / 耐药树脂', ex=(0, -0.08, 0))
    p = Part()
    p.box(IL - 0.001, IH - 0.001, IW - 0.001, (0, YB + IH / 2, 0), 'liq_water')
    emit(p, 'liq', '槽里的水 / 稀药液', '液体',
         '冲洗时是 DIW；注药时是稀药液（例如 HF 1:100）。满槽注药是"边进边溢"，浓度按 1 − e^(−t/τ) 慢慢爬上去，τ = 槽容积 ÷ 流量。', 'DIW / 稀药液', cap=False)
    p = Part()
    inlet_tubes(p)
    p.pipe([(-0.150, YB + 0.016, -0.150), (-0.150, PAN_Y - 0.04, -0.150)], 0.012, 'pfa')
    emit(p, 'inlet', '槽底进液管和喷嘴', G,
         'DIW（和注进去的药）从这里进槽：两条管沿着晶圆排列的方向，一排小孔斜着朝里朝上喷，水往上穿过片间，把片间的旧液顶出去。'
         '所以晶圆下半部先碰到新液，上下的处理量有一点差别（批内均匀性）。', 'PFA', ex=(0, -0.05, 0))
    megasonic()
    mega_gen((0.0, 0.102, 0.30))

    # 快排阀（大口径，槽底侧面）
    p = Part()
    qx = IL / 2 + T
    p.ring(0.030, 0.024, 0.05, (qx + 0.022, YB + 0.035, 0), 'x', 'pfa', 20)
    p.cyl(0.036, 0.07, (qx + 0.058, YB + 0.035, 0), 'y', 'pfa', 20)                 # 阀体
    p.ring(0.030, 0.024, 0.05, (qx + 0.058, YB - 0.022, 0), 'y', 'pfa', 20)         # 出口朝下
    p.cyl(0.030, 0.09, (qx + 0.058, YB + 0.115, 0), 'y', 'alu', 20)                 # 气缸
    p.cyl(0.034, 0.01, (qx + 0.058, YB + 0.165, 0), 'y', 'dark', 20)
    p.cyl(0.008, 0.02, (qx + 0.058, YB + 0.075, 0), 'y', 'sus', 10)
    emit(p, 'qdr', '快排阀 V9（大口径）', G,
         '装在槽底侧面，口径很大：一打开，一槽 42 L 的水几秒钟就排空，落进接液槽。这就是快排冲洗（QDR）：排一次，残液只剩约 2 %，比一直溢流稀释得快。'
         '代价：排空的那几秒晶圆露在空气里，所以要配淋浴。上面的气缸带动里面的阀芯。', 'PFA 阀体 + 气缸', ex=(0.22, 0, 0.05))
    p = Part()
    p.cyl(0.022, 0.05, (qx + 0.012, YB + 0.035, 0), 'x', 'pfa', 16)                 # 阀芯（示意）
    p.cyl(0.006, 0.08, (qx + 0.058, YB + 0.05, 0), 'y', 'sus', 10)
    emit(p, 'qdr_plug', '快排阀的阀芯', G, '气缸把它拉开，排液口就通了。口径大、行程短，所以开得快。（示意）', 'PTFE', ex=(0.34, 0.02, 0.05))

    # 淋浴
    p = Part()
    for s in (-1, 1):
        z = s * (IW / 2 + 0.035)
        p.cyl(0.009, 0.34, (0, YT + 0.075, z), 'x', 'pfa', 14)
        for i in range(9):
            x = (i - 4) * 0.036
            d = Vector((0, -0.75, -s * 0.66))
            p.cyl(0.0045, 0.016, Vector((x, YT + 0.075, z)) + d.normalized() * 0.014, d, 'pfa', 8, r2=0.0065)
    p.cyl(0.009, IW + 0.07, (-0.17, YT + 0.075, 0), 'z', 'pfa', 14)
    p.pipe([(-0.17, YT + 0.075, -(IW / 2 + 0.035)), (-0.17, YT + 0.075, -0.32)], 0.009, 'pfa')
    p.valve((-0.17, YT + 0.075, -0.36), 'z', 'y', 0.035)
    p.pipe([(-0.17, YT + 0.075, -0.40), (-0.17, YT + 0.075, -0.47)], 0.009, 'pfa')
    emit(p, 'shower', '淋浴喷嘴 + 淋浴阀 V8', G,
         '槽口两侧各一根管，下面一排喷嘴斜着朝晶圆喷 DIW。快排时开：液面降下去的那几秒，晶圆一直被喷湿。图形缝里的水膜一旦开始干，毛细力会把高宽比大的线条拉倒（图形倒塌），淋浴就是防这个。'
         '快排后补水时也一直喷，到晶圆重新浸没为止。', 'PFA', ex=(0, 0.22, 0))

    # 供液：冷 / 热 DIW → 流量控制 → 混合块（注入阀）→ 槽底
    p = Part()
    mx, my, mz = -0.02, 0.31, -0.16
    p.box(0.24, 0.05, 0.05, (mx, my, mz), 'pfa')
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.cyl(0.004, 0.006, (mx + sx * 0.11, my + sy * 0.017, mz + 0.027), 'z', 'sus', 6)
    emit(p, 'mix', '混合块', '供液',
         'DIW 从一头进来，穿过这块 PFA；五个注入阀插在后面，按比例把原液注进这股水里，混好以后进槽。槽里的浓度 = 原液流量 ÷ 总流量。在线混合，所以单槽不用配药罐，换药也灵活。', 'PFA', ex=(0, -0.10, -0.10))
    p = Part()
    for i in range(5):
        x = mx - 0.09 + i * 0.045
        z = mz - 0.12 - (i % 2) * 0.07
        p.pipe([(x, my, mz - 0.025), (x, my, z + 0.03)], 0.006, 'pfa', 8)
        p.valve((x, my, z), 'z', 'y', 0.03)
        p.pipe([(x, my, z - 0.03), (x, my, -0.47)], 0.006, 'pfa', 8)
    emit(p, 'inject', '注入阀 V3～V7（HF、HCl、NH₄OH、H₂O₂ 大 / 小）', '供液',
         '五路原液的注入阀，前后错开排。H₂O₂ 有两路：配比浓的时候注入流量大，稀的时候很小，一个阀覆盖不了这么宽的范围，所以分大流量、小流量两个。酸和碱的注入阀不能同时开（联锁）。',
         'PFA 气动阀', ex=(0, -0.10, -0.26))
    p = Part()
    fx, fz = -0.24, -0.16
    p.box(0.04, 0.016, 0.04, (fx, 0.185, fz), 'pfa')
    p.ring(0.012, 0.009, 0.07, (fx, 0.228, fz), 'y', 'quartz', 14)                  # 玻璃管流量计
    p.cyl(0.007, 0.01, (fx, 0.225, fz), 'y', 'dark', 10)                            # 浮子
    p.box(0.04, 0.016, 0.04, (fx, 0.27, fz), 'pfa')
    p.box(0.046, 0.05, 0.046, (fx, 0.303, fz), 'pfa')                               # 流量调节阀
    p.cyl(0.011, 0.02, (fx, 0.303, fz + 0.033), 'z', 'dark', 12)
    for i, x in enumerate((fx, fx - 0.05)):                                         # 冷 / 热 DIW 阀
        p.pipe([(x, 0.15, -0.47), (x, 0.15, -0.40)], 0.008, 'pfa')
        p.valve((x, 0.15, -0.36), 'z', 'y', 0.035)
        p.pipe([(x, 0.15, -0.32), (x, 0.15, fz), (fx, 0.15, fz), (fx, 0.177, fz)], 0.008, 'pfa')
    p.pipe([(fx, 0.328, fz), (fx, 0.345, fz), (fx + 0.06, 0.345, fz), (fx + 0.06, my, fz), (mx - 0.12, my, mz)], 0.008, 'pfa')
    p.pipe([(mx + 0.12, my, mz), (mx + 0.16, my, mz), (mx + 0.16, 0.36, mz), (-0.150, 0.36, -0.150), (-0.150, PAN_Y - 0.04, -0.150)], 0.010, 'pfa')
    emit(p, 'fcv', '冷 / 热 DIW 阀 V1、V2 + 流量控制', '供液',
         '冷 DIW、热 DIW 各一个阀，汇合以后过流量控制：下面是带浮子的玻璃管流量计（浮子越高流量越大），上面是流量调节阀，把进槽的总流量稳在设定值。'
         '注药的配比按这个总流量算，流量不稳，浓度就不稳。SPM 之后先用热水冲：硫酸黏、难冲。', 'PFA；流量计玻璃管', ex=(-0.14, -0.10, -0.16))

    # 排液分流
    p = Part()
    dx, dz = -0.20, 0.12
    p.pipe([(dx, PAN_Y - T, dz), (dx, 0.37, dz)], 0.016, 'pfa')
    p.ball(0.02, (dx, 0.355, dz), 'pfa')
    for i, x in enumerate((dx - 0.055, dx, dx + 0.055)):
        p.pipe([(dx, 0.355, dz), (x, 0.355, dz), (x, 0.30, dz)], 0.012, 'pfa')
        p.valve((x, 0.26, dz), 'y', 'z', 0.04)
        y = 0.09 + i * 0.035
        p.pipe([(x, 0.22, dz), (x, y, dz), (x, y, -0.40 - i * 0.03)], 0.012, 'pfa')
        p.cyl(0.016, 0.60, (0, y, -0.40 - i * 0.03), 'x', 'pfa', 12)
    emit(p, 'drain', '排液分流阀 V10～V12（酸 / 碱 / 回收）', '排液',
         '接液槽底下一根排液管，分成三路，同时只开一路：酸排液、碱排液、DIW 回收。注药的那一刻就切到对应的那路；冲干净（比电阻 ≥ 10 MΩ·cm）以后还要再溢流 30 s 才切回收；快排的水永远不进回收。'
         '酸碱进了回收会污染整个回收系统，这是联锁要查的。', 'PFA 管 + 气动阀', ex=(-0.16, -0.12, 0.14))

    # 传感器
    p = Part()
    x, z = IL / 2 - 0.025, -(IW / 2 - 0.025)
    p.cyl(0.007, 0.30, (x, YT - 0.085, z), 'y', 'pfa', 12)
    p.ring(0.0095, 0.0065, 0.04, (x, YT - 0.235, z), 'y', 'sus', 14)               # 外电极
    p.cyl(0.0035, 0.046, (x, YT - 0.237, z), 'y', 'sus', 8)                        # 中心电极
    p.cyl(0.015, 0.045, (x, YT + 0.085, z), 'y', 'sus', 14)
    emit(p, 'res', '比电阻计', '仪表',
         '装在槽里的长杆，下端是同心的两个电极（中心一根、外面一圈），测两极之间水的电阻。25 °C 的纯水是 18.2 MΩ·cm，离子越多越低。冲洗就是看它升没升上来。'
         '要注意：它只代表探头那一处的水，死区里冲没冲干净它不知道。', 'PFA 护套；电极钛 / 不锈钢', ex=(0.10, 0.28, -0.10))
    p = Part()
    x, z = -IL / 2 + 0.025, IW / 2 - 0.022
    p.pipe([(x, YB + 0.12, z), (x, 1.045, z), (x, 1.045, z + 0.09)], 0.0045, 'pfa', 10)
    p.cyl(0.011, 0.03, (x, 1.045, z + 0.105), 'z', 'sus', 12)
    x2 = -IL / 2 + 0.07
    p.cyl(0.006, 0.36, (x2, YT - 0.14, z + 0.003), 'y', 'pfa', 10)                 # 液位计（示意）
    p.cyl(0.013, 0.03, (x2, YT + 0.055, z + 0.003), 'y', 'sus', 12)
    px = -(PAN_L / 2 - 0.03)
    p.cyl(0.006, 0.10, (px, PAN_Y + 0.07, -0.13), 'y', 'pfa', 10)                  # 接液槽液位开关
    p.cyl(0.012, 0.03, (px, PAN_Y + 0.135, -0.13), 'y', 'sus', 12)
    emit(p, 'sensors', '测温探头 + 槽液位计 + 接液槽液位开关', '仪表',
         '测温探头（Pt100，PFA 包覆）上端弯过槽沿。槽液位计：快排"排空了"、补水"满了"、淋浴喷到"晶圆浸没"都靠它判断，液位不够也不能开兆声。'
         '接液槽里的液位开关：正常没水，涨到这里说明排液不通，报警、停止供液。', 'PFA 包覆', ex=(-0.10, 0.28, 0.12))

    base(posts=((-0.20, 0.20), (-0.17, 0.17)), top=PAN_Y - T)
    lifter(-0.31)
    ex_x = IL / 2 + 0.045
    flows('flow_main', upflow_arrows('flow_water') + [
        ('flow_water', [(-0.13, YT - 0.01, -0.08), (-0.185, YT + 0.035, -0.08), (-ex_x, YT - 0.10, -0.08), (-ex_x, PAN_Y + 0.06, -0.08)]),    # 两端溢流 → 接液槽
        ('flow_water', [(-0.13, YT - 0.01, 0.08), (-0.185, YT + 0.035, 0.08), (-ex_x, YT - 0.10, 0.08), (-ex_x, PAN_Y + 0.06, 0.08)]),
        ('flow_water', [(0.13, YT - 0.01, -0.08), (0.185, YT + 0.035, -0.08), (ex_x, YT - 0.10, -0.08), (ex_x, PAN_Y + 0.20, -0.08)]),
        ('flow_water', [(-0.12, 0.345, -0.18), (-0.150, 0.40, -0.18), (-0.150, PAN_Y + 0.06, -0.18)]),                                         # 进液
        ('flow_drain', [(-0.11, PAN_Y + 0.02, 0.16), (-0.165, PAN_Y + 0.02, 0.16), (-0.165, 0.39, 0.16)]),                                           # 接液槽 → 排液
        ('flow_water', [(-0.06, YT + 0.06, -0.19), (-0.06, YT - 0.03, -0.10)]), ('flow_water', [(0.06, YT + 0.06, -0.19), (0.06, YT - 0.03, -0.10)]),   # 淋浴
    ])


# ================= 减压干燥槽 =================
CH_L, CH_W, CH_Y0, CH_Y1, CH_T = 0.52, 0.49, 0.50, 1.46, 0.012     # 密封腔：内部长、宽，底、口，壁厚


def build_dryer():
    begin('dr')
    G = '减压干燥槽'
    p = Part()
    tank_walls(p, IL, IW, YB, YT + 0.014, T, 'quartz', x_low=0.014)
    for x in (-0.12, 0.12):
        for z in (-0.13, 0.13):
            p.box(0.04, YB - T - CH_Y0, 0.04, (x, (YB - T + CH_Y0) / 2, z), 'pfa')
    emit(p, 'tank', '槽体（水槽）', G,
         '下面这一槽是干净的 DIW，晶圆先浸在里面。也能上流冲洗、注 HF（HF 放到干燥槽里做：HF 之后冲干净，不出液面直接干燥，疏水面不碰空气）。水从两端溢流，落到密封腔的底上。', '石英', ex=(0, 0, 0))
    p = Part()
    tank_walls(p, CH_L, CH_W, CH_Y0, CH_Y1, CH_T, 'clear')
    for s in (-1, 1):                                                                   # 腔口的法兰
        p.box(CH_L + 2 * CH_T + 0.06, 0.016, 0.03, (0, CH_Y1 - 0.008, s * (CH_W / 2 + CH_T + 0.015)), 'clear')
        p.box(0.03, 0.016, CH_W + 2 * CH_T, (s * (CH_L / 2 + CH_T + 0.015), CH_Y1 - 0.008, 0), 'clear')
    emit(p, 'chamber', '密封腔（下半部分兼接液槽）', G,
         '把水槽整个罩住的腔。盖上盖子就密封：先通 N₂ 把氧赶走（IPA 可燃），晶圆提上来以后减压，最后用 N₂ 回到大气压才能开盖。'
         '水槽两端溢流出来的水落在腔底，从腔底的排液口走，所以腔的下半部分就是接液槽。上半部分是气体空间，晶圆提上来以后停在这里干燥。', '透明耐药树脂 / 不锈钢（示意成透明的）', ex=(0, 0, 0))
    p = Part()
    p.box(CH_L + 2 * CH_T + 0.07, 0.025, CH_W + 2 * CH_T + 0.07, (0, CH_Y1 + 0.0165, 0), 'pvc')
    p.box(0.20, 0.006, 0.20, (0, CH_Y1 + 0.032, 0), 'clear')                           # 观察窗
    for s in (-1, 1):
        p.box(0.03, 0.03, 0.12, (s * 0.22, CH_Y1 + 0.044, 0), 'dark')
    emit(p, 'lid__lid', '密封盖', G,
         '关上才能供 IPA、才能减压；开盖之前要先回到大气压（不然压着打不开，硬开会把外面的空气猛地吸进去）。盖子没关好，IPA 阀和真空阀都被联锁锁住。', '耐药树脂 / 不锈钢，带观察窗',
         ex=(0, 0.30, 0), mv=(0, 0.06, -0.66), mvg='lid')
    p = Part()
    for s in (-1, 1):
        p.box(CH_L + 2 * CH_T + 0.03, 0.006, 0.008, (0, CH_Y1 + 0.003, s * (CH_W / 2 + CH_T + 0.012)), 'rubber')
        p.box(0.008, 0.006, CH_W + 2 * CH_T + 0.03, (s * (CH_L / 2 + CH_T + 0.012), CH_Y1 + 0.003, 0), 'rubber')
    emit(p, 'oring', '密封圈', G, '盖子和腔口之间的 O 形圈：减压时外面的大气压把盖子压在它上面，越抽越紧。它老化、沾了颗粒就漏气，压力抽不下去。', '氟橡胶 / 全氟橡胶', ex=(0, 0.16, 0))
    p = Part()
    p.box(IL - 0.001, IH - 0.014, IW - 0.001, (0, YB + (IH - 0.014) / 2, 0), 'liq_water')
    emit(p, 'liq', '槽里的水', '液体', '干净的 DIW。晶圆从水里慢慢提出来：水面附近 IPA 浓、表面张力小，下面的水表面张力大，这个差把晶圆上的水膜拉回槽里（Marangoni 效应）。', 'DIW', cap=False)
    p = Part()
    p.box(IL - 0.001, 0.013, IW - 0.001, (0, YT - 0.0065, 0), 'liq_ipa')
    emit(p, 'ipa_layer', '水面上的 IPA 层', '液体',
         'IPA 比水轻（0.79 g/cm³），落在水面上铺成一层。它和水完全互溶，界面会慢慢扩散成一段浓度梯度，所以要一直供才维持得住。'
         '晶圆穿过这一层时，图形缝里的水被换成 IPA：表面张力只有水的约 1/3，干燥时毛细力小得多，图形不容易倒。', 'IPA', cap=False, ex=(0, 0.12, 0))
    p = Part()
    inlet_tubes(p)
    p.pipe([(-0.150, YB + 0.016, -0.150), (-0.150, CH_Y0 - 0.05, -0.150)], 0.012, 'pfa')
    emit(p, 'inlet', '槽底进液管', G, '上流冲洗、注药时，DIW（和 HF / HCl）从槽底进来。和单槽的一样。', 'PFA', ex=(0, -0.05, 0))

    # IPA、N₂
    p = Part()
    for s in (-1, 1):
        z = s * 0.205
        p.cyl(0.008, 0.36, (0, YT + 0.045, z), 'x', 'pfa', 12)
        for i in range(9):
            x = (i - 4) * 0.038
            d = Vector((0, -0.8, -s * 0.6))
            p.cyl(0.0035, 0.014, Vector((x, YT + 0.045, z)) + d.normalized() * 0.012, d, 'pfa', 8)
    p.cyl(0.008, 0.41, (0.19, YT + 0.045, 0), 'z', 'pfa', 12)
    p.pipe([(0.19, YT + 0.045, -0.205), (0.19, YT + 0.045, -0.32)], 0.008, 'pfa')
    p.valve((0.19, YT + 0.045, -0.36), 'z', 'y', 0.035)
    p.pipe([(0.19, YT + 0.045, -0.40), (0.19, YT + 0.045, -0.47)], 0.008, 'pfa')
    emit(p, 'ipa', 'IPA 供给：液面喷嘴 + IPA 阀 V9', 'IPA / N₂',
         '贴着水面的两根管，小孔朝下朝里，IPA 落在水面上铺成一层。IPA 可燃（闪点约 12 °C）：盖子没关好、氧浓度没降到 2 % 以下，IPA 阀打不开（联锁）。管子从腔的后壁穿进来，阀在腔外面。',
         'PFA', ex=(0.10, 0.16, -0.10))
    p = Part()
    for s in (-1, 1):
        z = s * 0.20
        p.cyl(0.008, 0.40, (0, CH_Y1 - 0.06, z), 'x', 'sus', 12)
        for i in range(10):
            p.cyl(0.004, 0.012, ((i - 4.5) * 0.038, CH_Y1 - 0.071, z - s * 0.004), 'y', 'sus', 8)
    p.cyl(0.008, 0.40, (-0.20, CH_Y1 - 0.06, 0), 'z', 'sus', 12)
    p.pipe([(-0.20, CH_Y1 - 0.06, -0.20), (-0.20, CH_Y1 - 0.06, -0.32)], 0.008, 'sus')
    p.valve((-0.20, CH_Y1 - 0.06, -0.36), 'z', 'y', 0.035)
    p.pipe([(-0.20, CH_Y1 - 0.06, -0.40), (-0.20, CH_Y1 - 0.06, -0.47)], 0.008, 'sus')
    p.pipe([(-0.10, CH_Y1 - 0.14, -(CH_W / 2 + CH_T)), (-0.10, CH_Y1 - 0.14, -0.32)], 0.008, 'sus')        # 破真空
    p.valve((-0.10, CH_Y1 - 0.14, -0.36), 'z', 'y', 0.035)
    p.pipe([(-0.10, CH_Y1 - 0.14, -0.40), (-0.10, CH_Y1 - 0.14, -0.47)], 0.008, 'sus')
    emit(p, 'n2', 'N₂ 喷嘴 + N₂ 阀 V7 + 破真空阀 V8', 'IPA / N₂',
         '腔顶两侧的喷嘴往下吹 N₂。三个用处：供 IPA 之前把氧赶走（置换）；干燥的最后把残留的液体吹干；减压以后经破真空阀通 N₂，回到大气压。用 N₂ 而不用空气：没有氧，不长水痕，IPA 也烧不起来。',
         '不锈钢 / PFA 管', ex=(-0.10, 0.22, -0.10))

    # 抽真空：真空接口 → 真空阀 → 冷阱 → 真空泵；排气阀
    p = Part()
    vx = CH_L / 2 + CH_T
    vz = -0.10
    p.ring(0.034, 0.018, 0.012, (vx + 0.006, 1.25, vz), 'x', 'sus', 20)                 # 接口法兰
    p.ring(0.034, 0.018, 0.012, (vx + 0.020, 1.25, vz), 'x', 'sus', 20)
    p.ring(0.038, 0.030, 0.010, (vx + 0.013, 1.25, vz), 'x', 'dark', 20)                # 卡箍
    p.pipe([(vx + 0.026, 1.25, vz), (vx + 0.07, 1.25, vz), (vx + 0.07, 0.86, vz)], 0.018, 'sus', 14)
    emit(p, 'vacport', '真空接口（法兰 + 卡箍）', '真空',
         '密封腔侧壁上的抽气口。两片法兰中间夹着密封圈，用卡箍箍紧：真空管路通用的快装接头，拆装方便，又不漏气。口径比液体管粗得多：压力越低气体越稀，管子细了抽不动。', '不锈钢', ex=(0.20, 0.05, -0.05))
    p = Part()
    p.valve((vx + 0.07, 0.82, vz), 'y', 'x', 0.05)
    p.pipe([(vx + 0.07, 0.775, vz), (vx + 0.07, 0.47, vz), (0.16, 0.47, vz), (0.16, 0.445, vz)], 0.018, 'sus', 14)
    emit(p, 'vacvalve', '真空阀 V10', '真空', '打开就开始减压。压力越低沸点越低：残留的水和 IPA 在低温下很快蒸发掉，氧也少。盖子没关不能开（联锁）；开着的时候排气阀、冷阱排液阀都得关着。', '不锈钢真空阀', ex=(0.24, 0, -0.08))
    p = Part()
    tx, ty, tz = 0.16, 0.39, vz
    p.ring(0.038, 0.032, 0.10, (tx, ty, tz), 'y', 'sus', 20)
    p.cyl(0.038, 0.006, (tx, ty + 0.053, tz), 'y', 'sus', 20)
    p.cyl(0.038, 0.006, (tx, ty - 0.053, tz), 'y', 'sus', 20)
    for i in range(5):
        p.ring(0.046, 0.038, 0.003, (tx, ty - 0.036 + i * 0.018, tz), 'y', 'alu', 20)
    emit(p, 'trap', '冷阱 · 外壳', '真空',
         '装在真空泵前面。抽出来的气体里带着 IPA 蒸气，在这里碰到冷的表面凝成液体留下来，不让它进泵（泵油 / 泵腔怕溶剂，排气里的 IPA 也少了）。凝下来的 IPA 积在底部，回到大气压以后从下面的排液阀排到有机排液。',
         '不锈钢', ex=(0.20, -0.06, -0.16), cut=(tx, tz))
    p = Part()
    for i in range(6):
        p.ring(0.026, 0.020, 0.008, (tx, ty - 0.035 + i * 0.014, tz), 'y', 'pfa', 16)    # 冷却盘管（示意）
    p.cyl(0.008, 0.10, (tx, ty, tz), 'y', 'sus', 10)
    emit(p, 'trap_coil', '冷阱 · 冷却盘管', '真空', '里面走冷却水 / 冷媒的盘管。气体绕着它流过，IPA 蒸气在冷的管壁上凝成液滴，滴到底部。（示意）', '不锈钢 / PFA', ex=(0.20, 0.14, -0.16), cut=False)
    p = Part()
    p.pipe([(tx + 0.02, ty - 0.056, tz), (tx + 0.02, ty - 0.075, tz), (tx + 0.09, ty - 0.075, tz), (tx + 0.09, 0.29, tz)], 0.008, 'pfa')
    p.valve((tx + 0.09, 0.255, tz), 'y', 'x', 0.035)
    p.pipe([(tx + 0.09, 0.22, tz), (tx + 0.09, 0.19, tz), (tx + 0.09, 0.19, -0.46)], 0.008, 'pfa')
    p.cyl(0.016, 0.60, (0, 0.19, -0.46), 'x', 'pfa', 12)
    emit(p, 'trap_drain', '冷阱排液阀 V12 → 有机排液', '真空', '回到大气压以后打开，把冷阱里凝下来的 IPA 排到有机排液。抽真空时不能开：会从排液口倒吸进空气，真空抽不下去（联锁）。', 'PFA 管 + 气动阀', ex=(0.30, -0.10, -0.16))
    p = Part()
    qx, qy, qz = 0.10, 0.17, vz
    p.box(0.15, 0.12, 0.13, (qx, qy, qz), 'pump')
    for i in range(4):
        p.box(0.004, 0.13, 0.14, (qx - 0.05 + i * 0.035, qy, qz), 'sus')
    p.cyl(0.05, 0.11, (qx - 0.13, qy, qz), 'x', 'dark', 18)                              # 电机
    p.cyl(0.020, 0.04, (0.16, qy + 0.075, qz), 'y', 'sus', 12)                           # 吸气口
    p.box(0.29, 0.012, 0.15, (qx - 0.04, qy - 0.066, qz), 'sus')
    p.pipe([(0.16, ty - 0.056, tz), (0.16, qy + 0.09, qz)], 0.016, 'sus')
    p.pipe([(qx, qy - 0.03, qz - 0.065), (qx, qy - 0.03, -0.47)], 0.016, 'sus')          # 排气 → 有机排风
    emit(p, 'vacpump', '真空泵（干式）', '真空', '把密封腔抽到减压（几 kPa）。干式：泵腔里没有油，不会有油蒸气倒流回去弄脏晶圆。抽出来的气体（N₂ + 一点 IPA 蒸气）排到有机排风。', '铸铁 / 铝（不接液）', ex=(0.10, -0.06, -0.26))
    p = Part()
    p.pipe([(0.10, CH_Y1 - 0.14, -(CH_W / 2 + CH_T)), (0.10, CH_Y1 - 0.14, -0.32)], 0.012, 'pfa')
    p.valve((0.10, CH_Y1 - 0.14, -0.36), 'z', 'y', 0.04)
    p.pipe([(0.10, CH_Y1 - 0.14, -0.40), (0.10, CH_Y1 - 0.14, -0.47)], 0.012, 'pfa')
    emit(p, 'exh', '排气阀 V11 → 有机排风', '真空', '关着盖、常压的时候一直开：供进来的 N₂、IPA 蒸气、注药时的雾气从这里走有机排风。抽真空和破真空时关。', 'PFA 管 + 气动阀', ex=(0.10, 0.20, -0.16))

    # 仪表
    p = Part()
    gx = -(CH_L / 2 + CH_T)
    p.cyl(0.006, 0.04, (gx - 0.02, 1.30, 0.12), 'x', 'sus', 10)
    p.cyl(0.035, 0.022, (gx - 0.05, 1.30, 0.12), 'x', 'sus', 22)                         # 压力表
    p.cyl(0.030, 0.002, (gx - 0.062, 1.30, 0.12), 'x', 'screen', 22)
    p.cyl(0.006, 0.04, (gx - 0.02, 1.18, 0.12), 'x', 'sus', 10)
    p.box(0.05, 0.06, 0.05, (gx - 0.065, 1.18, 0.12), 'dark')                            # 氧浓度计
    p.box(0.002, 0.03, 0.035, (gx - 0.091, 1.185, 0.12), 'screen')
    x, z = IL / 2 - 0.025, -IW / 2 + 0.025
    p.cyl(0.007, 0.30, (x, YT - 0.085, z), 'y', 'pfa', 12)                               # 比电阻计
    p.ring(0.0095, 0.0065, 0.04, (x, YT - 0.235, z), 'y', 'sus', 14)
    p.cyl(0.015, 0.04, (x, YT + 0.08, z), 'y', 'sus', 14)
    emit(p, 'gauges', '压力计 + 氧浓度计 + 比电阻计', '仪表',
         '压力计：回到大气压才能开盖。氧浓度计：氧降到 2 % 以下才能供 IPA（IPA 的爆炸下限约 2 %，再留余量，配方目标 1 %）。比电阻计在水槽里：冲洗、注药以后，冲干净才能开始干燥。', '不锈钢；比电阻计 PFA 护套',
         ex=(-0.20, 0.10, 0.10))

    # 槽里的水：混合块、排水阀、腔底排液分流
    p = Part()
    mx, my, mz = -0.05, 0.31, -0.16
    p.box(0.18, 0.05, 0.05, (mx, my, mz), 'pfa')
    for i in range(2):
        x = mx - 0.04 + i * 0.05
        p.pipe([(x, my, mz - 0.025), (x, my, -0.33)], 0.006, 'pfa', 8)
        p.valve((x, my, -0.36), 'z', 'y', 0.03)
        p.pipe([(x, my, -0.39), (x, my, -0.47)], 0.006, 'pfa', 8)
    p.pipe([(mx - 0.13, 0.15, -0.47), (mx - 0.13, 0.15, -0.40)], 0.008, 'pfa')
    p.valve((mx - 0.13, 0.15, -0.36), 'z', 'y', 0.035)
    p.pipe([(mx - 0.13, 0.15, -0.32), (mx - 0.13, 0.15, mz), (mx - 0.13, my, mz), (mx - 0.09, my, mz)], 0.008, 'pfa')
    p.pipe([(mx + 0.09, my, mz), (mx + 0.12, my, mz), (mx + 0.12, 0.37, mz), (-0.150, 0.37, -0.150), (-0.150, CH_Y0 - 0.05, -0.150)], 0.010, 'pfa')
    emit(p, 'mix', '混合块 + DIW 阀 V1 + 注入阀 V2、V3（HF、HCl）', '供液 / 排液',
         '和单槽一样的在线混合，只接 HF、HCl 两种。干燥槽也接药液的原因：HF 之后表面疏水，一碰空气水膜就缩成水珠、留下水痕；放到干燥槽里做，HF、冲洗、干燥一气呵成，晶圆不出液面。'
         '同一个容器里做药液、冲洗、干燥，公开专利里有先例（docs/管路.md 第 5 节）。', 'PFA', ex=(-0.10, -0.12, -0.20))
    p = Part()
    dx, dz = -0.07, 0.13
    qx2 = IL / 2 + T
    p.ring(0.024, 0.019, 0.04, (qx2 + 0.018, YB + 0.03, -0.10), 'x', 'pfa', 16)
    p.cyl(0.028, 0.06, (qx2 + 0.05, YB + 0.03, -0.10), 'y', 'pfa', 16)
    p.cyl(0.024, 0.07, (qx2 + 0.05, YB + 0.10, -0.10), 'y', 'alu', 16)
    p.ring(0.024, 0.019, 0.04, (qx2 + 0.05, YB - 0.02, -0.10), 'y', 'pfa', 16)
    p.pipe([(dx, CH_Y0 - CH_T, dz), (dx, 0.40, dz)], 0.014, 'pfa')
    p.ball(0.018, (dx, 0.385, dz), 'pfa')
    for i, x in enumerate((dx - 0.04, dx + 0.04)):
        p.pipe([(dx, 0.385, dz), (x, 0.385, dz), (x, 0.33, dz)], 0.012, 'pfa')
        p.valve((x, 0.29, dz), 'y', 'z', 0.04)
        y = 0.10 + i * 0.045
        p.pipe([(x, 0.25, dz), (x, y, dz), (x, y, -0.40 - i * 0.03)], 0.012, 'pfa')
        p.cyl(0.016, 0.60, (0, y, -0.40 - i * 0.03), 'x', 'pfa', 12)
    emit(p, 'drain', '排水阀 V4 + 腔底排液分流 V5、V6（酸 / 回收）', '供液 / 排液',
         '水槽侧面的排水阀：换水、HF 之后把槽里的水排到腔底。腔底一根排液管分两路：酸排液、DIW 回收，规则和单槽一样。干燥槽不做快排冲洗：快排会让晶圆露出液面，在这里做 HF 就没意义了。',
         'PFA 管 + 气动阀', ex=(-0.06, -0.14, 0.16))

    base(posts=((-0.24, 0.24), (-0.21, 0.21)), top=CH_Y0 - CH_T)
    lifter(-0.215, inside=True)
    flows('flow_main', [
        ('flow_gas', [(-0.08, CH_Y1 - 0.09, -0.20), (-0.08, CH_Y1 - 0.20, -0.14)]), ('flow_gas', [(0.08, CH_Y1 - 0.09, -0.20), (0.08, CH_Y1 - 0.20, -0.14)]),     # N₂ 往下吹
        ('flow_ipa', [(-0.08, YT + 0.035, -0.19), (-0.08, YT + 0.008, -0.13)]), ('flow_ipa', [(0.04, YT + 0.035, -0.19), (0.04, YT + 0.008, -0.13)]),            # IPA 落在水面上
        ('flow_gas', [(0.16, 1.25, -0.04), (CH_L / 2 + CH_T + 0.03, 1.25, -0.04), (CH_L / 2 + CH_T + 0.13, 1.25, -0.04), (CH_L / 2 + CH_T + 0.13, 0.95, -0.04)]),    # 抽真空
        ('flow_water', [(-0.09, YB + 0.03, -0.135), (-0.09, YB + 0.10, -0.07), (-0.09, YT - 0.06, -0.07)]),
        ('flow_water', [(-0.13, YT - 0.01, -0.08), (-0.185, YT + 0.035, -0.08), (-(IL / 2 + 0.045), YT - 0.10, -0.08), (-(IL / 2 + 0.045), CH_Y0 + 0.06, -0.08)]),
    ])


# ================= 搬送（中等精细） =================
def build_transfer():
    begin('tr')
    G1, G2 = '装载', '槽间搬送'
    fy = 0.975                                      # FOUP 里最下面一片的高度
    fx = {1: -1.10, 2: -0.66}
    fz = 0.30
    for n in (1, 2):
        x = fx[n]
        p = Part()
        p.box(0.46, 0.90, 0.46, (x, 0.45, fz), 'pvc')
        p.box(0.44, 0.02, 0.40, (x, 0.915, fz), 'sus')                                  # 载台
        for dx, dz in ((-0.12, 0.12), (0.12, 0.12), (0, -0.13)):
            p.cyl(0.008, 0.016, (x + dx, 0.932, fz + dz), 'y', 'sus', 10)               # 定位销
        p.box(0.46, 0.50, 0.03, (x, 1.19, fz - 0.245), 'pvc')                            # 设备侧的门框
        emit(p, f'lp{n}', f'装载口 {n}', G1,
             'FOUP 放在载台上，三个定位销卡住盒底的三道槽，每次都落在同一个位置。然后载台把 FOUP 推向设备，FOUP 的门和设备的门贴在一起、一起打开：晶圆从头到尾只对着设备里的洁净空间。',
             '载台不锈钢；外壳树脂', ex=(0, -0.10, 0.25))
        p = Part()
        tank_walls(p, 0.38, 0.33, 0, 0.33, 0.006, 'clear')
        p.box(0.392, 0.006, 0.342, (0, 0.333, 0), 'clear')
        for s in (-1, 1):
            p.box(0.05, 0.02, 0.10, (s * 0.20, 0.25, 0), 'dark')                         # 把手
        bmesh.ops.rotate(p.bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'), verts=p.bm.verts[:])     # 开口朝 −z（朝设备）
        bmesh.ops.translate(p.bm, vec=(x, 0.94 + 0.171, fz + 0.165), verts=p.bm.verts[:])
        emit(p, f'foup{n}', f'FOUP {n}（晶圆盒）', G1, '装 25 片 300 mm 晶圆的密闭盒子，晶圆水平放，上下间距 10 mm。开口朝设备。两个 FOUP 合成一批 50 片。', '透明树脂（聚碳酸酯之类）', ex=(0, 0.25, 0.30))
        p = Part()
        p.box(0.37, 0.31, 0.012, (x, 0.94 + 0.171, fz - 0.172), 'pvc')
        p.cyl(0.012, 0.006, (x - 0.08, 0.94 + 0.171, fz - 0.181), 'z', 'dark', 10)
        p.cyl(0.012, 0.006, (x + 0.08, 0.94 + 0.171, fz - 0.181), 'z', 'dark', 10)
        emit(p, f'foupdoor{n}__door', f'FOUP {n} 的门', G1, '平时锁着。到了装载口，设备的开门机构用两把"钥匙"拧开它的锁，把门吸住、往后拉、再降下去，晶圆就露出来了。', '树脂', ex=(0, 0.25, -0.20),
             mv=(0, -0.36, -0.03), mvg='door')
        p = Part()
        wafer_stack(p, cx=0, cy=0, n=25, pitch=0.010, axis='y')
        bmesh.ops.translate(p.bm, vec=(x, fy + 0.12, fz), verts=p.bm.verts[:])
        emit(p, f'foupwafers{n}', f'FOUP {n} 里的晶圆（25 片）', '晶圆', '水平放着的 25 片。开门后晶圆映射传感器上下扫一遍：每个槽位有没有片、有没有叠片或斜片。', '硅', ex=(0, 0.25, 0.60))

    # 批量取片机械手
    p = Part()
    bx, bz = -0.88, -0.22
    p.cyl(0.10, 0.90, (bx, 0.45, bz), 'y', 'pvc', 24)
    p.cyl(0.07, 0.10, (bx, 0.95, bz), 'y', 'sus', 20)
    p.box(0.10, 0.07, 0.20, (bx, 1.035, bz + 0.05), 'alu')
    p.box(0.06, 0.34, 0.03, (bx, 1.14, bz + 0.135), 'alu')
    for i in range(25):
        y = fy + i * 0.010 - 0.003
        p.box(0.20, 0.0025, 0.22, (bx, y, bz + 0.26), 'pfa')                             # 叶片
    emit(p, 'batch', '批量取片机械手（25 片叶片）', G1,
         '一把 25 片叶片的"梳子"，间距 10 mm，一次伸进 FOUP，把 25 片晶圆一起托出来。一片一片取太慢，批量设备的节拍靠这一步。第二盒取出来以后交错插进第一盒的空隙：间距从 10 mm 变成 5 mm，50 片合成一批。',
         '叶片陶瓷 / PEEK；手臂铝', ex=(0, 0.10, -0.30))

    # 姿态变换单元（画成已经转到竖直）
    px = -0.20
    p = Part()
    p.box(0.12, 1.02, 0.12, (px, 0.51, -0.26), 'pvc')
    p.box(0.14, 0.14, 0.12, (px, 1.20, -0.26), 'dark')                                   # 转动电机
    p.cyl(0.022, 0.10, (px, 1.20, -0.18), 'z', 'sus', 14)
    emit(p, 'posture_base', '姿态变换单元 · 立柱和转轴', G1, '把整批晶圆从水平转成竖直（进槽前），回来时再转回水平。槽里的晶圆是竖着放的，FOUP 里是水平的，中间必须转 90°。', '树脂外壳；轴不锈钢', ex=(0, -0.05, -0.25))
    p = Part()
    p.box(0.30, 0.012, 0.30, (px, 1.20 - 0.175, 0), 'pfa')
    for s in (-1, 1):
        p.box(0.012, 0.20, 0.30, (px + s * 0.150, 1.20 - 0.08, 0), 'pfa')
    comb_rod(p, 1.20 - 0.158, 0, x0=px - 0.145, x1=px + 0.145)
    emit(p, 'posture__cradle', '姿态变换单元 · 托架', G1, '托着整批晶圆一起转。底下也是带槽的导杆：转到竖直以后，每片晶圆立在自己的槽里，等槽间搬送机械手来夹走。（这里画的是已经转到竖直的样子）', 'PFA / PEEK', ex=(0, 0.05, 0.35))

    # 导轨 + 槽间搬送机械手
    p = Part()
    p.box(1.9, 0.07, 0.09, (-0.15, 1.74, -0.50), 'sus')
    p.box(1.9, 0.02, 0.025, (-0.15, 1.785, -0.47), 'dark')
    p.box(1.9, 0.02, 0.025, (-0.15, 1.695, -0.47), 'dark')
    for x in (-1.05, 0.75):
        p.box(0.08, 1.70, 0.08, (x, 0.85, -0.50), 'pvc')
    emit(p, 'rail', '导轨', G2, '槽间搬送机械手沿着它在装载区和各个槽之间水平移动，全线只有这一条。多批同时在线时，机械手就是瓶颈（吊车调度问题）。', '不锈钢 / 铝型材', ex=(0, 0.20, -0.20))
    rx = 0.40
    p = Part()
    p.box(0.26, 0.22, 0.15, (rx, 1.74, -0.39), 'pvc')                                    # 行走部
    p.box(0.08, 0.28, 0.08, (rx, 1.57, -0.39), 'sus')
    p.box(0.09, 0.06, 0.50, (rx, 1.50, -0.17), 'sus')                                    # 伸到槽上方的手臂
    p.box(0.44, 0.05, 0.07, (rx, 1.465, 0), 'sus')                                       # 横梁（夹爪挂在下面）
    p.box(0.10, 0.07, 0.42, (rx, 1.505, 0), 'alu')                                       # 开合机构
    emit(p, 'robot', '槽间搬送机械手 · 行走部和手臂', G2,
         '夹着整批 50 片晶圆在槽之间水平移动。它只管水平搬：槽里的上下动作交给每个槽自己的升降器。交接时双方都要确认对方到位、晶圆在不在，才能动下一步（交接联锁）。'
         '搬过药液里出来的晶圆以后，夹爪要先去清洗干燥位洗干净。', '不锈钢 / 铝；外面包耐药树脂', ex=(0, 0.15, -0.25))
    for s, nm in ((-1, 'B'), (1, 'F')):
        p = Part()
        z = s * 0.137
        for hx in (-0.175, 0.175):
            p.box(0.012, 0.36, 0.03, (rx + hx, 1.28, z), 'pfa')
        comb_rod(p, 1.20 - 0.075, z, x0=rx - 0.175, x1=rx + 0.175)
        emit(p, f'chuck__{nm}', f'夹爪（{"后" if s < 0 else "前"}）', G2,
             '两根带槽的导杆，从两侧夹住整批晶圆下半圈的边缘：每片卡在一道齿缝里。合上 = 夹住，张开 = 松开。夹爪碰过带药液的晶圆，上面沾着药：不洗的话药液会干在上面，或者被带到下一个槽、下一批。',
             'PFA / PEEK', ex=(0, 0.10, s * 0.20), mv=(0, 0, s * 0.063), mvg='chuck')
    p = Part()
    wafer_stack(p, cx=rx, cy=1.20)
    emit(p, 'wafers', '夹爪上的一批晶圆（50 片）', '晶圆', '被夹爪夹着、正在搬送的一批。从药液槽提出来到浸进下一个槽，这段在空气里的时间有上限：表面带着的药液还在反应，局部变干就会留下残留。', '硅', ex=(0, -0.20, 0.45))
    p = Part()
    p.box(2.3, 0.012, 1.10, (-0.25, 0.046, 0.0), 'pvc')
    emit(p, 'floor', '底板', '机架', '', '', ex=(0, -0.10, 0))


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    STATE['mats'] = make_materials()
    STATE['col'] = bpy.context.scene.collection
    build_chembath()
    build_onebath()
    build_dryer()
    build_transfer()
    n_parts = sum(1 for ob, _, _ in PARTS if 'part_no' in ob)
    n_alt = make_cuts()
    os.makedirs(OUT_DIR, exist_ok=True)
    glb = os.path.join(OUT_DIR, 'wetbench_detail.glb')
    bpy.ops.export_scene.gltf(
        filepath=glb, export_format='GLB', export_yup=True, export_apply=False, export_extras=True,
        export_texcoords=False, export_normals=True, export_materials='EXPORT', export_cameras=False, export_lights=False,
        export_animations=False, use_selection=False,
    )
    nv = sum(len(o.data.vertices) for o in bpy.data.objects if o.type == 'MESH')
    print(f'零件 {n_parts} 个，剖切版另出 {n_alt} 个，顶点 {nv}，{glb}：{os.path.getsize(glb) / 1e6:.2f} MB')
    if '--blend' in sys.argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, 'wetbench_detail.blend'), compress=True)


if __name__ == '__main__':
    main()
