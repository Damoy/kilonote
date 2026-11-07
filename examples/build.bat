@echo off
REM An example for the syntax coloring only: KiloNote never runs files.
set TARGET=%1
if "%TARGET%"=="" set TARGET=release
echo Would build the %TARGET% version
:end
