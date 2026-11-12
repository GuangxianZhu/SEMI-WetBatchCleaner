// 把 web/index.html + web/app.js + sim/（three.js 走 CDN，开发用）打包成一个离线 html：双击就能打开，不用联网。
//
//   npm install && npm run build（在仓库根目录）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');

const out = await build({
  entryPoints: [join(root, 'web', 'app.js')], bundle: true, format: 'iife', minify: true, write: false,
  target: ['es2019', 'chrome80', 'safari14'], legalComments: 'none',
});
const js = out.outputFiles[0].text.replaceAll('</script', '<\\/script');

// 细模型（python build_wetbench.py 生成的 output/wetbench_detail.glb）：先压缩（去重、合并顶点、meshopt），再以 base64 嵌进页面。
// 压缩只影响嵌进去的这一份，output/ 里的 glb 不动（以后导进 VR 用原始的）。
async function detailGlb() {
  const src = join(root, 'output', 'wetbench_detail.glb');
  if (!existsSync(src)) { console.warn('没有 output/wetbench_detail.glb：细模型不会嵌进去（先运行 python build_wetbench.py）'); return ''; }
  let bytes = readFileSync(src);
  const raw = bytes.length;
  try {
    const { NodeIO } = await import('@gltf-transform/core');
    const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
    const { dedup, weld, meshopt } = await import('@gltf-transform/functions');
    const { MeshoptEncoder, MeshoptDecoder } = await import('meshoptimizer');
    await MeshoptEncoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
    const doc = await io.readBinary(new Uint8Array(bytes));
    doc.setLogger({ debug() {}, info() {}, warn: console.warn, error: console.error });
    await doc.transform(dedup(), weld(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    bytes = Buffer.from(await io.writeBinary(doc));
  } catch (e) { console.warn('glb 没有压缩（照原样嵌进去）：' + e.message); }
  console.log(`细模型 glb：${(raw / 1024).toFixed(0)} KB → 嵌入 ${(bytes.length / 1024).toFixed(0)} KB`);
  return bytes.toString('base64');
}
const glb = await detailGlb();

const page = html
  .replace('<script id="glbData" type="application/octet-stream"></script>', () => '<script id="glbData" type="application/octet-stream">' + glb + '</script>')
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replace('<script type="module" src="./app.js"></script>', () => '<script>' + js + '</script>');
mkdirSync(join(root, 'output'), { recursive: true });
const dst = join(root, 'output', '槽式清洗机_离线版.html');
writeFileSync(dst, page);
console.log(dst, (page.length / 1024).toFixed(0), 'KB');
