// 打包出「解压就能用」的 HelloBoss.exe:自带 Node 运行时的 exe + 源码 + 空简历目录。
//
// 结构上刻意只把「引导层」打进 exe(bootstrap.cjs),src/ 仍然躺在磁盘上 —— 所以这个
// exe 只在 Node 大版本变化时才需要重打,平时改 src/ 直接生效。
//
// 只用 Node 内置模块。唯一的外部工具是 postject,由 npx 现下现用:所以「打包」这一步
// 需要联网,而打出来的 exe 运行起来不需要任何东西。仓库运行期仍是零依赖。
//
// 用法:node launcher/build.mjs      (或双击上层目录的 打包exe.cmd)
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const DIST = path.join(SERVER_DIR, 'dist');
const WORK = path.join(HERE, '.build');
const EXE = path.join(DIST, 'HelloBoss.exe');

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

fs.rmSync(DIST, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

// 1) 把引导层打成 SEA blob
const blob = path.join(WORK, 'sea-prep.blob');
const configFile = path.join(WORK, 'sea-config.json');
fs.writeFileSync(configFile, JSON.stringify({
  main: path.join(HERE, 'bootstrap.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
}, null, 2));
run(process.execPath, ['--experimental-sea-config', configFile]);

// 2) 复制一份 node.exe,再把 blob 注入进去 —— 这一步之后 exe 就自带 Node 运行时了。
//    postject 会报 "The signature seems corrupted":它把 Node 官方签名改坏了,属预期,
//    代价是从网上下到这个 exe 的人首次运行会被 SmartScreen 问一次。
fs.copyFileSync(process.execPath, EXE);
runShell(`npx --yes ${POSTJECT} "${EXE}" NODE_SEA_BLOB "${blob}" --sentinel-fuse ${FUSE}`);

// 3) 组装目录。只放别人跑起来需要的东西:自己的简历不进包(那是个人信息),
//    config/server.json 也不进(局域网令牌是本机的)。data/ 由服务自己建。
fs.cpSync(path.join(SERVER_DIR, 'src'), path.join(DIST, 'src'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'config'), { recursive: true });
fs.copyFileSync(path.join(SERVER_DIR, 'config', 'keywords.json'), path.join(DIST, 'config', 'keywords.json'));
fs.mkdirSync(path.join(DIST, 'resumes'), { recursive: true });
fs.copyFileSync(path.join(SERVER_DIR, 'resumes', 'example.txt'), path.join(DIST, 'resumes', 'example.txt'));

// 油猴脚本必须一起进包:服务是给脚本问的,没有脚本这个包根本跑不起来。
const userscript = path.join(SERVER_DIR, '..', 'zhipin-auto-greeting.user.js');
fs.copyFileSync(userscript, path.join(DIST, 'zhipin-auto-greeting.user.js'));

// 记事本认 BOM 才稳,不然老版本 Windows 上这份中文说明会变乱码。
fs.writeFileSync(path.join(DIST, '使用说明.txt'), Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  fs.readFileSync(path.join(HERE, '使用说明.txt')),
]));

console.log('');
console.log(`[打包完成] ${DIST}`);
console.log('  把整个 dist 文件夹压成 zip 发出去,对方解压后双击 HelloBoss.exe 即可。');
