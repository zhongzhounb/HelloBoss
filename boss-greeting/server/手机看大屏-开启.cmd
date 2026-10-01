@echo off
chcp 936 >nul
rem 让手机能看大屏:生成访问令牌 + 防火墙放行 TCP 8787。需要管理员权限。
rem 不做开机自启:服务由 打开大屏.cmd 或 启动服务.cmd 手动拉起。
rem 维护注意:GBK 编码 + CRLF 行尾(原因见 启动服务.cmd 顶部注释)。
setlocal enabledelayedexpansion
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo 需要管理员权限,因为要改防火墙规则:请右键本文件,选「以管理员身份运行」。
  pause
  exit /b 1
)

echo === 1/3 访问令牌 ===
if exist "config\server.json" (
  echo 已存在 config\server.json,沿用里面的令牌。
) else (
  for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"`) do set "NEWTOKEN=%%t"
  > "config\server.json" echo {"lan": true, "token": "!NEWTOKEN!"}
  echo 已生成 config\server.json
)

set "TOKEN="
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "(Get-Content 'config\server.json' -Raw | ConvertFrom-Json).token"`) do set "TOKEN=%%t"
if "!TOKEN!"=="" (
  echo 读不到 config\server.json 里的 token,请检查文件内容。
  pause
  exit /b 1
)

echo.
echo === 2/3 防火墙放行 TCP 8787 ===
netsh advfirewall firewall delete rule name="boss-ai-gate 8787" >nul 2>&1
netsh advfirewall firewall add rule name="boss-ai-gate 8787" dir=in action=allow protocol=TCP localport=8787 profile=any >nul
if errorlevel 1 (echo 防火墙规则添加失败) else (echo 已放行)

echo.
echo === 3/3 手机访问地址 ===
echo 手机连同一个 WiFi,依次试下面这些地址,挑能打开的那个:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "CAND=%%a"
  set "CAND=!CAND: =!"
  if not "!CAND:~0,4!"=="127." if not "!CAND:~0,8!"=="169.254." echo    http://!CAND!:8787/dashboard?token=!TOKEN!
)
echo.
echo 打开一次之后 cookie 会记住令牌,以后直接开 http://本机IP:8787/dashboard 即可。
echo 建议把带 token 的那条存成书签,手机 cookie 过期时重进一次就行。
echo 撤销用 手机看大屏-关闭.cmd。
echo.
echo 服务必须重启一次才会对局域网开放。现在跑的是只监听 127.0.0.1 的进程。
set /p RESTART=现在就重启服务吗?会中断正在跑的脚本任务,确定请输入 Y :
if /i "!RESTART!"=="Y" call "%~dp0重启服务.cmd"

pause
endlocal
