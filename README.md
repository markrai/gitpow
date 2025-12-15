<img width="400" height="400" alt="image-Photoroom" src="https://github.com/user-attachments/assets/f25bdc63-c7dd-45d5-b166-e24d76a3e626" />
<img width="500" height="220" alt="image" src="https://github.com/user-attachments/assets/5dfd6463-5af7-405c-992d-d2e61d330936" />
<img width="1080" height="606" alt="image" src="https://github.com/user-attachments/assets/684bd3b6-0697-4b9b-8493-8e6604c551fc" />

# Why?

This is a passion project of mine where I wanted a cross-platform git client, which would tackle some of the pain-points of existing solutions. Namely, conditional strategies to handle larger repositories (i.e. Kubernetes, Linux kernel, etc.) More importantly, I wanted to implement certain ergonomics which I didn't find in other clients, such as: showing image previews to visualize what changed (if an image was replaced, for example), grouping commits by month/year, giving the user more customization over how they wished to see dates (human-readable, versus timestamps), or how many "commits ago" a file was introduced. As a fun challenge, I wanted to provide the user the option to visualize the repo as a vertical, or horizontal graph, which could be navigated (and zoomed in/out of) on a touch-screen. This is a work in progress, and I welcome any suggestions, or better yet - contributions to the project! 😊


## Prerequisites

### All Platforms

1. **Rust** (latest stable version)
   - Install from [rustup.rs](https://rustup.rs/)
   - Verify: `rustc --version`

2. **Node.js** (v18 or later)
   - Install from [nodejs.org](https://nodejs.org/)
   - Verify: `node --version`

3. **wasm-pack**
   - Install: `cargo install wasm-pack`
   - Verify: `wasm-pack --version`

4. **Tauri CLI**
   - Install: `cargo install tauri-cli`
   - Verify: `cargo tauri --version`


### Windows-Specific

- **Microsoft Visual C++ Build Tools** or **Visual Studio** with C++ support
  - Required for building native dependencies
  - Download from [Microsoft](https://visualstudio.microsoft.com/downloads/)

### Linux-Specific

Install system dependencies:

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev \
    xdg-utils
```

**Fedora:**
```bash
sudo dnf install webkit2gtk4.1-devel.x86_64 \
    openssl-devel \
    curl \
    wget \
    file \
    libappindicator-gtk3 \
    librsvg2-devel
```

**Arch Linux:**
```bash
sudo pacman -S webkit2gtk \
    base-devel \
    curl \
    wget \
    openssl \
    libappindicator \
    librsvg
```

### macOS-Specific

1. **Xcode Command Line Tools**
   ```bash
   xcode-select --install
   ```

2. **Homebrew** (recommended)
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

## Building Executables

### Step 1: Install Dependencies

```bash
# Install Node.js dependencies
npm install
```

### Step 2: Build WebAssembly Module

The graph visualization requires a WebAssembly module that must be built first:

**Windows:**
```cmd
cd graph-wasm
wasm-pack build --target web
cd ..
```

**Linux/macOS:**
```bash
cd graph-wasm
wasm-pack build --target web
cd ..
```

**Copy WASM files to static directory:**

**Windows:**
```cmd
if not exist "static\graph-wasm\pkg" mkdir "static\graph-wasm\pkg"
xcopy /Y /I "graph-wasm\pkg\*" "static\graph-wasm\pkg\"
```

**Linux/macOS:**
```bash
mkdir -p static/graph-wasm/pkg
cp -r graph-wasm/pkg/* static/graph-wasm/pkg/
```

### Step 3: Build Executables

#### Windows

**Development Build:**
```cmd
cargo tauri dev
```

**Release Build:**
```cmd
cargo tauri build
```

The executable will be located at:
```
src-tauri/target/release/gitpow.exe
```

**Installer:**
The installer will be created at:
```
src-tauri/target/release/bundle/msi/gitpow_0.1.0_x64_en-US.msi
```

#### Linux

**Development Build:**
```bash
cargo tauri dev
```

**Release Build:**
```bash
cargo tauri build
```

The executable will be located at:
```
src-tauri/target/release/gitpow-tauri
```

**Note:** The executable name is `gitpow-tauri` (matching the Cargo package name), not `gitpow`.

**AppImage:**
```
src-tauri/target/release/bundle/appimage/gitpow_0.1.0_amd64.AppImage
```

**Debian Package:**
```
src-tauri/target/release/bundle/deb/gitpow_0.1.0_amd64.deb
```

#### macOS

**Development Build:**
```bash
cargo tauri dev
```

**Release Build:**
```bash
cargo tauri build
```

The application bundle will be located at:
```
src-tauri/target/release/bundle/macos/GitPow.app
```

**DMG:**
```
src-tauri/target/release/bundle/dmg/gitpow_0.1.0_x64.dmg
```

**Note:** On macOS, you may need to sign the application for distribution. See [Tauri's macOS Code Signing documentation](https://tauri.app/v1/guides/distribution/macos).

## Building for Specific Targets

### Cross-Compilation

#### Building Windows executable from Linux/macOS

Install the Windows target:
```bash
rustup target add x86_64-pc-windows-gnu
```

Install MinGW-w64 (Linux):
```bash
# Ubuntu/Debian
sudo apt install gcc-mingw-w64-x86-64

# macOS
brew install mingw-w64
```

Build:
```bash
cargo tauri build --target x86_64-pc-windows-gnu
```

#### Building Linux executable from Windows/macOS

Install the Linux target:
```bash
rustup target add x86_64-unknown-linux-gnu
```

Use Docker or a Linux VM for building. See the [Docker Build](#docker-build) section below.

#### Building macOS executable from Linux/Windows

macOS executables must be built on macOS due to code signing requirements. You can:

1. **Build on a Mac:**
   ```bash
   cargo tauri build
   ```

2. **Use GitHub Actions** with macOS runners (see `.github/workflows/release.yml`)

3. **Use a macOS CI/CD service** (e.g., GitHub Actions, CircleCI with macOS support)

Docker cannot build macOS executables as macOS Docker images are not available for standard Docker setups.

## Docker Build

For building in Docker containers (useful for isolated builds or cross-platform development), you can use the provided Docker setup. This allows you to build Linux and Windows executables from any host OS.

**Supported platforms in Docker:**
- ✅ Linux (native)
- ✅ Windows (cross-compiled using MinGW-w64)
- ❌ macOS (requires macOS host - see [macOS Build](#building-macos-executable-from-linuxwindows) section)

### Prerequisites

- Docker and Docker Compose installed
- Git repository cloned

### Building with Docker Compose

#### Building for Linux

The easiest way to build for Linux using Docker:

```bash
# Build the Docker image (first time only, or when dependencies change)
docker-compose build builder-linux

# Run the build (this will automatically build the application)
docker-compose run --rm builder-linux
```

#### Building for Windows (Cross-compilation)

You can cross-compile Windows executables from Linux using Docker:

```bash
# Build the Windows Docker image
docker-compose build builder-windows

# Run the Windows build
docker-compose run --rm builder-windows
```

The Windows executable will be at `build-output/windows/gitpow-tauri.exe`.

#### Building for All Platforms

To build both Linux and Windows:

```bash
# Build all images
docker-compose build

# Build Linux
docker-compose run --rm builder-linux

# Build Windows
docker-compose run --rm builder-windows
```

Or use the test script (Windows):
```cmd
test-win&linux_builds.bat
```

**Note:** macOS builds cannot be done in Docker and require a macOS host. See [macOS Build](#macos-build) section below.

#### macOS Build

macOS builds require a macOS system. To test the macOS build:

```bash
# On macOS, run the test script
chmod +x test-macos-build.sh
./test-macos-build.sh
```

Or build manually:
```bash
# Build WASM
cd graph-wasm && wasm-pack build --target web && cd ..
mkdir -p static/graph-wasm/pkg
cp -r graph-wasm/pkg/* static/graph-wasm/pkg/

# Build Tauri
cargo tauri build
```

The application bundle will be at:
- `src-tauri/target/release/bundle/macos/GitPow.app`
- DMG installer: `src-tauri/target/release/bundle/dmg/gitpow_0.1.2_x64.dmg`

The built executable will be available in:
- Inside container: `/gitpow/target/release/gitpow-tauri` (when building from workspace root)
- On host (if build-output directory exists): `./build-output/gitpow-tauri`

**Note:** When building from the workspace root with Docker, the executable is at `target/release/gitpow-tauri` (not `src-tauri/target/release/gitpow-tauri`). This is because Cargo uses the workspace target directory when building from the root.

The docker-compose setup automatically:
1. Mounts your project directory into the container
2. Caches Cargo and Rustup data for faster subsequent builds
3. Builds the WebAssembly module
4. Builds the Tauri application
5. Copies the executable to `./build-output/` if the directory exists

**Note:** 
- The first build may take 30-60 minutes. Subsequent builds are much faster due to caching.
- The executable name is `gitpow-tauri` (matching the Cargo package name), not `gitpow`.
- The built executable is a **Linux binary** (ELF format) and will not run natively on Windows. To test it:
  - Use WSL (Windows Subsystem for Linux): `wsl ./build-output/gitpow-tauri`
  - Transfer it to a Linux machine
  - Run it in the Docker container: `docker-compose run --rm builder /gitpow/target/release/gitpow-tauri`

### Building with Docker directly

Alternatively, you can use the Dockerfile directly:

```bash
# Build the image
docker build -t gitpow-builder .

# Run the build (mount your source code)
docker run --rm \
  -v "$(pwd):/gitpow" \
  -v cargo-cache:/root/.cargo \
  -v rustup-cache:/root/.rustup \
  gitpow-builder \
  /bin/bash -c "cd /gitpow && rustup target add wasm32-unknown-unknown && cd graph-wasm && wasm-pack build --target web && cd .. && mkdir -p static/graph-wasm/pkg && cp -r graph-wasm/pkg/* static/graph-wasm/pkg/ && cargo tauri build"
```

### Docker Image Details

The Docker setup uses `jlesage/baseimage-gui:debian-12-v4` as the base image and includes:

- All required system dependencies (including `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev`, `xdg-utils`)
- Node.js (v24) via nvm
- Rust toolchain via rustup
- wasm-pack and tauri-cli

The build process:
1. Clones the repository (or uses the current directory if mounted)
2. Builds the WebAssembly module
3. Copies WASM files to the static directory
4. Builds the Tauri application

**Note:** The first build may take 30-60 minutes as it compiles all Rust dependencies. Subsequent builds are much faster due to Docker layer caching.

## Development

### Running in Development Mode

**Windows:**
```cmd
dev.bat
```

**Linux/macOS:**
```bash
# Build WASM first
cd graph-wasm && wasm-pack build --target web && cd ..
mkdir -p static/graph-wasm/pkg
cp -r graph-wasm/pkg/* static/graph-wasm/pkg/

# Run Tauri dev
cargo tauri dev
```

### Environment Variables

- `RUST_LOG`: Controls Rust logging level (default: `debug` in dev mode)
  - Options: `error`, `warn`, `info`, `debug`, `trace`
  - Example: `RUST_LOG=info cargo tauri dev`

## Build Output Locations

All build outputs are located in `src-tauri/target/`:

- **Debug builds**: `src-tauri/target/debug/`
- **Release builds**: `src-tauri/target/release/`
- **Bundles**: `src-tauri/target/release/bundle/`

## Troubleshooting

### WebAssembly Build Issues

If `wasm-pack build` fails:
1. Ensure `wasm-pack` is installed: `cargo install wasm-pack`
2. Check Rust version: `rustc --version` (should be 1.70+)
3. Install the wasm32 target: `rustup target add wasm32-unknown-unknown`

### Tauri Build Issues

**Windows:**
- Ensure Visual C++ Build Tools are installed
- Check that `cargo` and `rustc` are in your PATH

**Linux:**
- Verify all system dependencies are installed (see Prerequisites)
- If GTK errors occur, install: `sudo apt install libgtk-3-dev`

**macOS:**
- Ensure Xcode Command Line Tools are installed
- If code signing errors occur, you may need to configure signing in `tauri.conf.json`

### Missing Libraries.js

The `static/libraries.js` file is auto-generated during build. If it's missing:
1. The build script (`src-tauri/build.rs`) should generate it automatically
2. If it doesn't, ensure `Cargo.toml` and `package.json` are readable
3. The file will be created in `static/libraries.js` during the build process

### Build Time Issues

- First build may take 10-30 minutes (compiling Rust dependencies)
- Subsequent builds are much faster (incremental compilation)
- Use `cargo tauri build --debug` for faster debug builds

## Project Structure

```
gitpow-rust/
├── src/                    # Rust library code
├── src-tauri/              # Tauri application
│   ├── src/               # Tauri commands
│   ├── icons/             # Application icons
│   ├── build.rs           # Build script (generates libraries.js)
│   └── tauri.conf.json    # Tauri configuration
├── static/                # Frontend files
│   ├── js/                # JavaScript modules
│   ├── graph.js           # Graph visualization
│   └── index.html         # Main HTML file
├── graph-wasm/            # WebAssembly module
│   └── src/              # Rust WASM source
└── scripts/              # Build scripts
```

# Features

Separation by month/year:

<img width="223" height="270" alt="{96BCC32B-59F5-4F7E-B183-E984E54E4F34}" src="https://github.com/user-attachments/assets/2335d4e4-8384-4ef5-b78f-3c2176bb9e1a" />

vertical graph view:

<img width="1920" height="1077" alt="image" src="https://github.com/user-attachments/assets/b2fd32b1-ed7b-4b05-8da5-9d9a1285e402" />

Image Diff Preview:

<img width="360" height="233" alt="{B3A8E29F-60C6-4C9C-971A-952394CD09FB}" src="https://github.com/user-attachments/assets/98616132-34e6-46ac-8984-d08339114e8c" />



