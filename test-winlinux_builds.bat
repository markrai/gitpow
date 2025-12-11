@echo off
setlocal enabledelayedexpansion

echo ========================================
echo GitPow Windows and Linux Build Test
echo ========================================
echo.
echo This script will build for:
echo   - Linux (native)
echo   - Windows (cross-compiled from Linux)
echo.
echo Note: macOS builds require a macOS host.
echo       Use test-macos-build.sh on a Mac.
echo.

REM Check if Docker is installed
echo [1/7] Checking Docker installation...
docker --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker is not installed or not in PATH
    echo Please install Docker Desktop from https://www.docker.com/products/docker-desktop
    pause
    exit /b 1
)
echo Docker found: 
docker --version

REM Check if Docker is running
echo.
echo [2/7] Checking if Docker daemon is running...
docker ps >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker daemon is not running
    echo Please start Docker Desktop and try again
    pause
    exit /b 1
)
echo Docker daemon is running
echo.

REM Detect docker-compose command
echo [3/7] Detecting docker-compose command...
docker compose version >nul 2>&1
if errorlevel 1 (
    set USE_DOCKER_COMPOSE=1
    echo Using: docker-compose
) else (
    set USE_DOCKER_COMPOSE=0
    echo Using: docker compose
)
echo.

REM Create build-output directories
echo [4/7] Creating build-output directories...
if not exist "build-output\linux" mkdir build-output\linux
if not exist "build-output\windows" mkdir build-output\windows
if not exist "build-output\macos" mkdir build-output\macos
echo Build output directories ready
echo.

REM Build Docker images
echo [5/7] Building Docker images (this may take 10-30 minutes)...
echo This is a one-time setup. Subsequent builds will be faster.
echo.
if !USE_DOCKER_COMPOSE!==1 (
    docker-compose build builder-linux builder-windows
) else (
    docker compose build builder-linux builder-windows
)
if errorlevel 1 (
    echo ERROR: Docker image build failed
    pause
    exit /b 1
)
echo Docker images built successfully
echo.

REM Build Linux
echo [6/7] Building Linux executable (this may take 30-60 minutes)...
echo.
if !USE_DOCKER_COMPOSE!==1 (
    docker-compose run --rm builder-linux
) else (
    docker compose run --rm builder-linux
)
if errorlevel 1 (
    echo ERROR: Linux build failed
    set LINUX_FAILED=1
) else (
    set LINUX_FAILED=0
)
echo.

REM Build Windows
echo [7/7] Building Windows executable (this may take 30-60 minutes)...
echo.
if !USE_DOCKER_COMPOSE!==1 (
    docker-compose run --rm builder-windows
) else (
    docker compose run --rm builder-windows
)
if errorlevel 1 (
    echo ERROR: Windows build failed
    set WINDOWS_FAILED=1
) else (
    set WINDOWS_FAILED=0
)
echo.

REM Verify outputs
echo ========================================
echo Verifying build outputs...
echo ========================================
echo.

set BUILD_COUNT=0

REM Check Linux build
if exist "build-output\linux\gitpow-tauri" (
    echo [OK] Linux build: build-output\linux\gitpow-tauri
    dir build-output\linux\gitpow-tauri
    set /a BUILD_COUNT+=1
) else (
    echo [FAIL] Linux build: Not found
    if !LINUX_FAILED!==1 (
        echo         Build failed - check logs above
    ) else (
        echo         File not copied - check container
    )
)
echo.

REM Check Windows build
if exist "build-output\windows\gitpow-tauri.exe" (
    echo [OK] Windows build: build-output\windows\gitpow-tauri.exe
    dir build-output\windows\gitpow-tauri.exe
    set /a BUILD_COUNT+=1
) else (
    echo [FAIL] Windows build: Not found
    if !WINDOWS_FAILED!==1 (
        echo         Build failed - check logs above
    ) else (
        echo         File not copied - check container
    )
)
echo.

REM macOS note
echo [INFO] macOS build:
echo         macOS builds require a macOS host machine.
echo         To build for macOS:
echo           1. Use a Mac with Xcode Command Line Tools
echo           2. Run: ./test-macos-build.sh
echo           3. Or use GitHub Actions with macOS runners
echo.

echo ========================================
echo Build Summary
echo ========================================
echo.
echo Successful builds: !BUILD_COUNT! / 2 (Linux and Windows)
echo.
if !BUILD_COUNT!==2 (
    echo All Docker-based builds completed successfully!
    echo.
    echo Linux executable: build-output\linux\gitpow-tauri
    echo Windows executable: build-output\windows\gitpow-tauri.exe
    echo.
    echo Note: Linux executable requires WSL or a Linux machine to run.
    echo       Windows executable can be run directly on Windows.
) else (
    echo Some builds failed. Check the logs above for details.
)
echo.
echo ========================================
echo Test complete!
echo ========================================
pause


