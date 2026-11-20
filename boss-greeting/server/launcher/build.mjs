// 打包出「一个文件就能跑」的 HelloBoss.exe。
//
// **exe 里装着全部东西**:引导层(bootstrap.cjs)+ src/ 的全部源码 + package.json +
// 油猴脚本。双击之后引导层把自己解包到一个按内容指纹命名的目录里,再从磁盘上
// import 那份副本 —— 所以磁盘上仍然需要源码文件,但那是 exe 自己写出来的,
// 用户不需要带着 src/ 文件夹走。
//
// 为什么不把源码直接跑在内存里:ESM 的 `import` 只认 URL,`data:` URL 又不支持相对
// 路径导入,而 src/ 内部全是 `./xxx.js` 这种相对导入。解包到磁盘是唯一不改一行
// 源码就能让 import 正常工作的办法;多出来的成本是几十毫秒的写文件,可忽略。
//
// 只用 Node 内置模块。唯一的外部工具是 postject,由 npx 现下现用:所以「打包」这一步
// 需要联网,而打出来的 exe 运行起来不需要任何东西。仓库运行期仍是零依赖。
//
// 用法:node launcher/build.mjs      (不需要再跑任何 .cmd 脚本)
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_KEY,
  collectAssets,
  computeBuildId,
  buildManifest,
} from './assets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const SRC_DIR = path.join(SERVER_DIR, 'src');
const DIST = path.join(SERVER_DIR, 'dist');
const WORK = path.join(HERE, '.build');
const EXE = path.join(DIST, 'HelloBoss.exe');
const USERSCRIPT_SRC = path.resolve(SERVER_DIR, '..', 'zhipin-auto-greeting.user.js');

// 这个 UUID 是 Node 官方写死的 SEA 哨兵,postject 靠它在 exe 里找注入点。
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
// 钉死版本:postject 目前最新就是 alpha,不钉的话某天它改了行为会让打包悄悄变样。
const POSTJECT = 'postject@1.0.0-alpha.6';

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit' });
}

// npx 在 Windows 上是 npx.cmd,execFileSync 直接调 .cmd 会报 EINVAL,只能过一层 shell。
// 路径里的空格用引号兜住。
function runShell(commandLine) {
  console.log(`$ ${commandLine}`);
  execSync(commandLine, { stdio: 'inherit' });
}

// 只清掉上一次的代码与产物,**保留** dist/data 里的用户文件(流水、配置、知识库)。
// 那是用户的全部身家 —— 不是构建产物。以前整目录 rmSync 会在重新打包时把这些一起
// 删掉,那是不可恢复的。
//
// 单文件之后 dist 里只剩 exe 和一份使用说明:源码、package.json、油猴脚本都进了 exe。
// 但清理列表里仍留着旧布局的 src/ 与 package.json —— 从老版本升级上来的 dist 里
// 还躺着它们,不删的话用户会以为自己该改那份 src/。resumes/ 是旧版的用户内容,不动。
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
for (const name of [
  'HelloBoss.exe',
  '使用说明.txt',
  'zhipin-auto-greeting.user.js',
  // 上一版布局的产物,现在已经不需要了。
  'src',
  'package.json',
]) {
  fs.rmSync(path.join(DIST, name), { recursive: true, force: true });
}

// 1) 收集资源并算出内容指纹。指纹既是 exe 的版本标识,也是解包目录名。
const assets = collectAssets({
  srcDir: SRC_DIR,
  serverDir: SERVER_DIR,
  userscriptFile: USERSCRIPT_SRC,
});
const buildId = computeBuildId(assets);
const manifest = buildManifest(assets, buildId);

// 清单本身也当资源塞进去 —— 引导层读它才知道该解包哪些文件、解到哪个目录。
const manifestFile = path.join(WORK, MANIFEST_KEY);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');

// 2) 把引导层 + 全部资源打成 SEA blob
const blob = path.join(WORK, 'sea-prep.blob');
const configFile = path.join(WORK, 'sea-config.json');
fs.writeFileSync(configFile, JSON.stringify({
  main: path.join(HERE, 'bootstrap.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
  // assets 的 key 就是解包后的相对路径(见 assets.mjs)。
  assets: { [MANIFEST_KEY]: manifestFile, ...assets },
}, null, 2));
run(process.execPath, ['--experimental-sea-config', configFile]);

// 3) 复制一份 node.exe,再把 blob 注入进去 —— 这一步之后 exe 就自带 Node 运行时了。
//    postject 会报 "The signature seems corrupted":它把 Node 官方签名改坏了,属预期,
//    代价是从网上下到这个 exe 的人首次运行会被 SmartScreen 问一次。
fs.copyFileSync(process.execPath, EXE);
runShell(`npx --yes ${POSTJECT} "${EXE}" NODE_SEA_BLOB "${blob}" --sentinel-fuse ${FUSE}`);

// 4) 使用说明照旧单独放一份:它是给「还没打开 exe 的人」看的,必须能在不解包的情况下
//    用记事本打开。记事本认 BOM 才稳,不然老版本 Windows 上中文会变乱码。
fs.writeFileSync(path.join(DIST, '使用说明.txt'), Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  fs.readFileSync(path.join(HERE, '使用说明.txt')),
]));

console.log('');
console.log(`[打包完成] ${DIST}`);
console.log(`  本次构建 id:${buildId}(资源 ${manifest.keys.length} 项)`);
console.log('  只需要把 HelloBoss.exe 发出去 —— 源码与油猴脚本都在它里面。');
console.log('  首次运行会把源码解包到 %LOCALAPPDATA%\\HelloBoss\\runtime\\<buildId>\\。');
console.log('  注意:dist/data 里的个人内容(配置、知识库、流水)不会被这个脚本清掉,');
console.log('  但也不要把它打进要发出去的压缩包。');
