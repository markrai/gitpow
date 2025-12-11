# Dockerfile for building GitPow
# https://github.com/markrai/gitpow
#
# Based on jlesage/baseimage-gui for GUI support
FROM docker.io/jlesage/baseimage-gui:debian-12-v4

# Install system dependencies
RUN apt-get update \
    && apt-get install -y \
        build-essential \
        curl \
        wget \
        file \
        libssl-dev \
        libgtk-3-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        xdg-utils \
        libsoup-3.0-dev \
        libjavascriptcoregtk-4.1-dev \
        libwebkit2gtk-4.1-dev \
        git \
        pkg-config \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js via nvm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
RUN bash -c 'source "$HOME/.nvm/nvm.sh" && nvm install 24 && nvm use 24 && nvm alias default 24'

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Set up environment for Rust and Node.js
ENV PATH="/root/.cargo/bin:/root/.nvm/versions/node/v24.0.0/bin:/usr/bin:/bin:${PATH}"

# Install Rust tools
RUN cargo install wasm-pack
RUN cargo install tauri-cli

# Pre-cache linuxdeploy dependencies
RUN mkdir -p /root/.cache/tauri
RUN curl -L -o /root/.cache/tauri/linuxdeploy-x86_64.AppImage https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage
RUN curl -L -o /root/.cache/tauri/linuxdeploy-plugin-appimage-x86_64.AppImage https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage
RUN curl -L -o /root/.cache/tauri/AppRun-x86_64 https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64
RUN chmod +x /root/.cache/tauri/linuxdeploy-x86_64.AppImage
RUN chmod +x /root/.cache/tauri/linuxdeploy-plugin-appimage-x86_64.AppImage
RUN chmod +x /root/.cache/tauri/AppRun-x86_64


# Set working directory
WORKDIR /gitpow

# Default command - expects source to be mounted or copied
# When used with docker-compose, source will be mounted
# When used standalone, you can copy source before building
CMD ["/bin/bash"]

