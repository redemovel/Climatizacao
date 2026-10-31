@echo off
rem Para e remove o servico PontePHC (executar como Administrador).
sc stop PontePHC
sc delete PontePHC
pause
