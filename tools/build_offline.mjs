// 把 web/index.html + web/app.js + sim/（three.js 走 CDN，开发用）打包成一个离线 html：双击就能打开，不用联网。
//
//   npm install && npm run build（在仓库根目录）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const page = html
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replace('<script type="module" src="./app.js"></script>', () => '<script>' + js + '</script>');
mkdirSync(join(root, 'output'), { recursive: true });
const dst = join(root, 'output', '槽式清洗机_离线版.html');
writeFileSync(dst, page);
console.log(dst, (page.length / 1024).toFixed(0), 'KB');
