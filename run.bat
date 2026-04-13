@echo off
chcp 65001 >nul
title Luma Palette Launcher

echo ========================================================
echo   Luma Palette for Clip Studio Paint - Launcher
echo ========================================================
echo.

set "PYTHON_EXE=python"
%PYTHON_EXE% --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in your PATH!
    echo Please install Python 3.10 or higher from https://www.python.org/
    pause
    exit /b
)

echo [1/2] Checking required Python packages...
%PYTHON_EXE% -m pip install -q -U pynput Pillow pystray opencv-python-headless numpy

if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies. Please check your network.
    pause
    exit /b
)

echo.
echo [2/2] Starting Luma Palette...
%PYTHON_EXE% luma_palette_csp.py

pause
