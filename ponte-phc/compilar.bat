@echo off
setlocal
cd /d "%~dp0"
if not exist BouncyCastle.Crypto.dll (
  echo Falta o ficheiro BouncyCastle.Crypto.dll nesta pasta. Copie-o da pasta C:\GuiasAT.
  pause
  exit /b 1
)
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
"%CSC%" /nologo /nowarn:0168,0219 /r:BouncyCastle.Crypto.dll /r:System.Data.dll /r:System.ServiceProcess.dll /r:System.Security.dll /out:PontePHC.exe PontePHC.cs > compilacao.txt 2>&1
if errorlevel 1 (
  type compilacao.txt
  echo.
  echo Erro ao compilar. Envie ao Claude o ficheiro compilacao.txt.
  pause
  exit /b 1
)
echo PontePHC.exe criado com sucesso.
pause
