@echo off
chcp 936 >nul
rem 撤销 手机看大屏-开启.cmd 的防火墙规则。保留 config\server.json(令牌就是手机书签里那个)。
rem 维护注意:GBK 编码 + CRLF 行尾(原因见 启动服务.cmd 顶部注释)。
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo 需要管理员权限,因为要删防火墙规则:请右键本文件,选「以管理员身份运行」。
  pause
  exit /b 1
)

echo === 删除防火墙规则 ===
netsh advfirewall firewall delete rule name="boss-ai-gate 8787" >nul 2>&1
if errorlevel 1 (echo 没有该规则) else (echo 已删除)

echo.
echo 保留了 config\server.json。想彻底恢复成只在本机看,
echo 把里面的 lan 改成 false,再跑一次 重启服务.cmd 即可。
pause
endlocal
