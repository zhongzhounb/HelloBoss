// 打进 HelloBoss.exe 里的资源清单。
//
// 为什么要有这个文件:exe 以前只装引导层,`src/` 必须躺在 exe 旁边,少一个文件就起不来。
// 现在把 `src/` + `package.json` + 油猴脚本一起塞进 exe 的 SEA blob,解包再 import ——
// 于是「一个 exe」成立,而不是「一个 exe 加一个文件夹」。
//
// 资源 key 就是解包后的相对路径(`src/server.js` 落到 `<runtime>/src/server.js`),
// 构建端与引导端共用这一份约定,免得两边各写一套字符串。
//
// 这里只用 Node 内置模块,且**不 import 任何 src/ 下的东西**:build.mjs 在打包时跑它,
// 测试也会 import 它,两者都不该顺带把服务启动起来。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 常量从 bootstrap.cjs 取 —— 引导层必须是单文件(SEA 只嵌 main,相对 require 会失败),
// 所以那份定义只能住在它里面,这里复用而不是另写一份。
//
// bootstrap.cjs 只在 `require.main === module` 时才启动服务,所以在这里 require 它
// 不会顺手把服务拉起来。
const { USERSCRIPT_NAME, MANIFEST_KEY } = createRequire(import.meta.url)('./bootstrap.cjs');

export { USERSCRIPT_NAME, MANIFEST_KEY };


// 收集要打进 exe 的全部文件。**目录扫描而不是手写文件名** ——
// 手写的那份迟早会漏掉新加的文件,而漏掉的表现是「exe 起不来」,不是「构建报错」。
export function collectAssets({ srcDir, serverDir, userscriptFile }) {
  const assets = {};

  for (const name of fs.readdirSync(srcDir).sort()) {
    // 只收 .js:src/ 下没有别的东西,显式过滤能让误加的临时文件不至于被静默打包。
    if (!name.endsWith('.js')) continue;
    const file = path.join(srcDir, name);
    if (!fs.statSync(file).isFile()) continue;
    assets[`src/${name}`] = file;
  }

  if (Object.keys(assets).length === 0) {
    throw new Error(`src 目录里没有可打包的 .js 文件:${srcDir}`);
  }

  // package.json 里只有 "type": "module" 是运行期需要的:解包出来的 src/*.js
  // 靠它才会被 Node 当成 ESM。少了它,import() 会按 CommonJS 解析,exe 一启动就报错。
  assets['package.json'] = path.join(serverDir, 'package.json');
  // 油猴脚本必须一起进包:没有脚本,这个 exe 就没有东西去调它。
  assets[USERSCRIPT_NAME] = userscriptFile;

  return assets;
}

// 内容指纹:同一份资源永远得到同一个 id,改一个字就换一个。
//
// 引导层用它当解包目录名 —— 两个不同版本的 exe 同时跑时各用各的目录,
// 不会出现「A 进程把 B 进程正在编译的源码覆盖掉」。同一版本重复启动则直接复用。
export function computeBuildId(assets) {
  const hash = crypto.createHash('sha256');
  // key 排序后再喂:fs.readdirSync 的顺序在不同文件系统上不保证一致,
  // 不排序会让同一份代码在不同的机器上算出不同的 id。
  for (const key of Object.keys(assets).sort()) {
    hash.update(key);
    hash.update('\0');
    hash.update(fs.readFileSync(assets[key]));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

// 写进 blob 的清单。keys 显式列出,解包端不必依赖 sea.getAssetKeys() ——
// 那个 API 在 Node 22/24 上的可用性不一致,而这里读一个资源就够了。
export function buildManifest(assets, buildId) {
  return { buildId, keys: Object.keys(assets).sort() };
}
