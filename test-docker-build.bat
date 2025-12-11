@echo off
setlocal enabledelayedexpansion

echo ========================================
echo GitPow Docker Build Test
echo ========================================
echo.

REM Check if Docker is installed
echo [1/6] Checking Docker installation...
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
echo [2/6] Checking if Docker daemon is running...
docker ps >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker daemon is not running
    echo Please start Docker Desktop and try again
    pause
    exit /b 1
)
echo Docker daemon is running
echo.

REM Create build-output directory
echo [3/6] Creating build-output directory...
if not exist "build-output" mkdir build-output
echo Build output directory ready
echo.

REM Detect docker-compose command (newer Docker Desktop uses "docker compose" without hyphen)
echo [4/6] Detecting docker-compose command...
docker compose version >nul 2>&1
if errorlevel 1 (
    set USE_DOCKER_COMPOSE=1
    echo Using: docker-compose
) else (
    set USE_DOCKER_COMPOSE=0
    echo Using: docker compose
)
echo.

REM Build Docker image
echo [5/6] Building Docker image (this may take 10-30 minutes)...
echo This is a one-time setup. Subsequent builds will be faster.
echo.
if !USE_DOCKER_COMPOSE!==1 (
    docker-compose build
) else (
    docker compose build
)
if errorlevel 1 (
    echo ERROR: Docker image build failed
    pause
    exit /b 1
)
echo Docker image built successfully
echo.

REM Run the build
echo [6/6] Running build (this may take 30-60 minutes on first run)...
echo This will compile the entire project. Please be patient...
echo.
if !USE_DOCKER_COMPOSE!==1 (
    docker-compose run --rm builder-linux
) else (
    docker compose run --rm builder-linux
)
if errorlevel 1 (
    echo ERROR: Build failed
    echo Check the error messages above for details
    pause
    exit /b 1
)
echo.

echo ========================================
echo Build complete!
echo ========================================
echo.
echo The build output can be found in the build-output/linux directory.
echo.
echo NOTE: This is a Linux executable (ELF binary) and will not run natively on Windows.
echo To test it:
echo   1. Use WSL: wsl ./build-output/linux/gitpow-tauri
echo   2. Transfer to a Linux machine
echo   3. Run in Docker: docker-compose run --rm builder-linux /gitpow/target/release/gitpow-tauri
echo.
echo You can copy it to your desired location for distribution to Linux systems.
echo.
echo ========================================
echo Test complete!
echo ========================================

