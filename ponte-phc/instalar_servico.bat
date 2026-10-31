@echo off
rem Instala e arranca o servico PontePHC (executar como Administrador).
cd /d "%~dp0"
if not exist PontePHC.exe ( echo Corra primeiro o compilar.bat. & pause & exit /b 1 )
sc create PontePHC binPath= "%~dp0PontePHC.exe" start= auto DisplayName= "PontePHC (PHC - Firebase Climatizacao)"
sc description PontePHC "Envia os clientes do PHC para a plataforma de Climatizacao (Firebase). So le o PHC."
sc failure PontePHC reset= 86400 actions= restart/60000/restart/60000/restart/300000
sc start PontePHC
echo.
echo Servico instalado. Veja o registo em logs\ e os erros em PontePHC_ERROS.txt.
pause
