// 高温药液槽（Chemical Bath）：一槽一种药，内槽溢流到外槽，泵 → 过滤器 → 加热器 → 打回内槽。
// 阶段 1 先把温度和浓度当作恒定（药液老化、补液、换液放到阶段 3）；
// 只记两件事：晶圆从单槽带进来的杂质（污染药液），兆声开没开。

import { P } from './params.js';
import { zeroConc, mixByParts, SPECIES } from './chem.js';

export class ChemBath {
  // kind：'SPM' 或 'SC1'
  constructor(kind) {
    this.kind = kind;
    this.T = 25;
    this.c = zeroConc();
    this.contam = zeroConc();   // 带进来的杂质，mol
    this.mega = false;
    this.megaP = 0;
    this.circ = true;           // 循环一直在跑
  }

  // SPM：H₂SO₄ : H₂O₂ = ratio : 1；SC1：NH₄OH : H₂O₂ : H₂O = nh3 : 1 : water
  configure(R) {
    if (this.kind === 'SPM') {
      this.T = R.spmT;
      this.c = mixByParts(P.stock, { H2SO4: R.spmRatio, H2O2: 1 });
    } else {
      this.T = R.sc1T;
      this.c = mixByParts(P.stock, { NH3: R.sc1Nh3, H2O2: 1 }, R.sc1Water);
    }
  }

  // 晶圆带进来的液体（从单槽来的残留）
  dragIn(volL, conc) { for (const s of SPECIES) this.contam[s] += (conc[s] || 0) * volL; }

  // 外来杂质浓度 mol/L
  contamConc(s) { return this.contam[s] / P.cbVol; }

  label() {
    return this.kind === 'SPM' ? 'SPM' : 'SC1';
  }
}
