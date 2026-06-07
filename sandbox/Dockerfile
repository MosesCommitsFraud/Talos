FROM node:22-bookworm-slim

RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update -o Acquire::Retries=5 -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=5 -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false ca-certificates \
    && apt-get update -o Acquire::Retries=5 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
    bash \
    bc \
    build-essential \
    bzip2 \
    cmake \
    curl \
    default-libmysqlclient-dev \
    diffutils \
    dnsutils \
    fd-find \
    freetds-bin \
    freetds-dev \
    ffmpeg \
    file \
    gfortran \
    git \
    gosu \
    htop \
    imagemagick \
    iputils-ping \
    jq \
    less \
    lsof \
    make \
    netcat-openbsd \
    net-tools \
    openssh-client \
    pandoc \
    patch \
    libpq-dev \
    libxml2-dev \
    libxslt1-dev \
    pkg-config \
    postgresql-client \
    procps \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    ripgrep \
    rsync \
    screen \
    socat \
    sqlite3 \
    strace \
    sysstat \
    sudo \
    telnet \
    tini \
    tmux \
    tree \
    tdsodbc \
    unixodbc \
    unixodbc-dev \
    unzip \
    wget \
    zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/talos-sandbox

COPY requirements.txt ./requirements.txt
RUN python3 -m venv /opt/talos-sandbox-venv \
    && /opt/talos-sandbox-venv/bin/pip install --no-cache-dir -r requirements.txt

# The npm package name is intentionally configurable because opencode packaging
# has changed across releases. Override OPENCODE_NPM_PACKAGE at build time if needed.
ARG OPENCODE_NPM_PACKAGE=opencode-ai
RUN npm install -g ${OPENCODE_NPM_PACKAGE}

COPY sandboxd.py ./sandboxd.py
COPY entrypoint.sh ./entrypoint.sh

RUN mkdir -p /home/talos /var/lib/talos-sandbox
RUN chmod +x ./entrypoint.sh

EXPOSE 7800

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./entrypoint.sh"]
