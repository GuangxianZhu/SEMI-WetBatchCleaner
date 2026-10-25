// 跑完一批以后的判定。合格线是教学用的原创值（量级参考公开资料），不是任何机台的规格。

import { STATION_NAME } from './params.js';

export const SPEC = { org: 0.02, particles: 50, fe: 1e10, chemOx: 0.1, thermOx: 3, si: 1.5, watermarks: 1, collapse: 0.01, air: 20 };

export const fmtE = v => {
  if (v <= 0) return '0';
  const e = Math.floor(Math.log10(v)), m = v / 10 ** e;
  const sup = String(e).split('').map(ch => '⁰¹²³⁴⁵⁶⁷⁸⁹'['0123456789'.indexOf(ch)] || (ch === '-' ? '⁻' : ch)).join('');
  return `${m.toFixed(1)}×10${sup}`;
};

export function evaluate(L) {
  const s = L.surf, R = L.R;
  const maxAir = L.air.log.reduce((m, a) => Math.max(m, a.t), 0);
  const worstAir = L.air.log.find(a => a.t === maxAir);

  const partHint = [];
  if (!R.mega || R.megaP < 50) partHint.push('兆声没开或功率太低：小颗粒主要靠兆声冲走。');
  if (s.siLoss < 0.5) partHint.push('SC1 太稀、太冷或太短：硅几乎没被刻，颗粒没被"掏松"。');
  if (s.carryMmol > 1) partHint.push(`冲洗不干净就进了 SC1：带进去约 ${s.carryMmol.toFixed(0)} mmol 杂质，变成盐粒粘在晶圆上，还污染了药液槽。`);
  if (maxAir > 30) partHint.push('搬得太慢：带着药液的表面在空气里局部变干，留下残留。');

  const wmHint = [];
  if (!R.ipa) wmHint.push('没用 IPA：提拉时没有 Marangoni 效应把水膜拉走。');
  else if (R.liftMmS > 2) wmHint.push(`提拉 ${R.liftMmS} mm/s 太快：水膜来不及被拉走就留在了晶圆上。`);
  if (worstAir && worstAir.from === 'ob2' && worstAir.t > 15) wmHint.push(`HF 之后在空气里待了 ${worstAir.t.toFixed(0)} s：疏水面上的水缩成水珠，干了就是水痕。`);

  const colHint = [];
  if (!R.shower) colHint.push('快排时没开淋浴：液面降下去时弯月面扫过图形，每快排一次就倒一批。');
  if (!R.ipa) colHint.push('没用 IPA：最后留在缝里的是水，表面张力是 IPA 的 3 倍多。');
  else if (R.liftMmS > 2) colHint.push('提拉太快：缝里留下的是水多、IPA 少的混合液。');

  const items = [
    { k: 'org', ok: s.org <= SPEC.org, label: '有机物去干净了（剩 ≤ 2 %）', val: `剩 ${(s.org * 100).toFixed(s.org < 0.001 ? 3 : 1)} %`,
      hint: 'SPM 温度太低或时间太短：有机物分解得不够。' },
    { k: 'part', ok: s.particles <= SPEC.particles, label: '颗粒 ≤ 50 个/片', val: `${s.particles.toFixed(0)} 个/片`,
      hint: partHint.join('') || '颗粒去除不够。' },
    { k: 'fe', ok: s.fe <= SPEC.fe, label: '金属 Fe ≤ 1×10¹⁰ atoms/cm²', val: `${fmtE(s.fe)} atoms/cm²`,
      hint: 'SC1 会让 Fe 沉积在表面；后面的 DHF 溶掉氧化膜时把嵌在里面的 Fe 一起带走。DHF 不够，Fe 就留下了。' },
    { k: 'ox', ok: s.chemOx <= SPEC.chemOx && s.hTerm, label: '化学氧化膜去净（表面疏水）', val: s.hTerm ? '去净，H 终端' : `还剩 ${s.chemOx.toFixed(2)} nm`,
      hint: 'DHF 太稀或注入时间太短：刻蚀量 = 整条浓度曲线的积分，不够去掉约 1 nm 的化学氧化膜。' },
    { k: 'thox', ok: s.thermOxLoss <= SPEC.thermOx, label: '热氧化膜损失 ≤ 3 nm', val: `${s.thermOxLoss.toFixed(1)} nm`,
      hint: 'DHF 太浓或注入太久：拖尾也在刻，刻蚀量 ≈ 速率(注入浓度) × 注入时间。' },
    { k: 'si', ok: s.siLoss <= SPEC.si, label: '硅损失 ≤ 1.5 nm', val: `${s.siLoss.toFixed(2)} nm · 粗糙度 Ra ${s.rough.toFixed(2)} nm`,
      hint: 'SC1 太浓或太热：氨水把硅刻掉，表面也变粗糙。可以把 SC1 稀释，用兆声补回去颗粒的能力。' },
    { k: 'wm', ok: s.watermarks < SPEC.watermarks, label: '没有水痕', val: `${s.watermarks.toFixed(0)} 个/片`,
      hint: wmHint.join('') || '干燥时留下了水膜。' },
    { k: 'col', ok: s.collapse <= SPEC.collapse, label: '图形倒塌 ≤ 1 %（示意测试图形）', val: `${(s.collapse * 100).toFixed(1)} %`,
      hint: colHint.join('') || '干燥时毛细力太大。' },
    { k: 'air', ok: maxAir <= SPEC.air, label: '每段搬送在空气里 ≤ 20 s', val: `最长 ${maxAir.toFixed(0)} s`,
      hint: worstAir ? `${STATION_NAME[worstAir.from]} → ${STATION_NAME[worstAir.to]} 这段太久。` : '' },
  ];
  const bad = items.filter(i => !i.ok).length;
  const u = L.usage();
  const stats = [
    `总时间 ${((L.t - (L.batchT0 || 0)) / 60).toFixed(0)} min`,
    `DIW ${u.diwL.toFixed(0)} L`,
    `HF 原液 ${(u.hfL * 1000).toFixed(0)} mL`,
    `IPA ${u.ipaL.toFixed(2)} L`,
    ...L.rinseLog.map(r => `${STATION_NAME[r.id]}上流 ${(r.t / 60).toFixed(1)} min`),
  ];
  return { items, bad, stats, violations: L.violations, notes: L.notes };
}
