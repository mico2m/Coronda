@echo off
cd /d "%~dp0"
echo Borra lo del modo Blender que ya no se usa:
echo   blender\coronda_vivo.py  (el addon)
echo   src\systems\object-tree.js  (el arbol que guardaba en Blender)
echo.
pause
if exist "blender\coronda_vivo.py" del /q "blender\coronda_vivo.py"
if exist "blender" rmdir "blender"
if exist "src\systems\object-tree.js" del /q "src\systems\object-tree.js"
echo Listo. Este archivo tambien se borra solo.
pause
(goto) 2>nul & del "%~f0"
