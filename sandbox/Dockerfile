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

# Make the venv (with pandas/numpy/matplotlib/openpyxl/etc. pre-installed) the
# default Python EVERYWHERE — including login shells (`bash -lc`), which re-source
# /etc/profile and would otherwise reset PATH and lose the venv. Without this the
# agent's bash sees only the bare system python3 (no data libs) and wastes turns
# trying to pip-install things that are already installed.
RUN printf 'export PATH=/opt/talos-sandbox-venv/bin:$PATH\n' > /etc/profile.d/zz-talos-venv.sh \
    && ln -sf /opt/talos-sandbox-venv/bin/python  /usr/local/bin/python \
    && ln -sf /opt/talos-sandbox-venv/bin/python  /usr/local/bin/python3 \
    && ln -sf /opt/talos-sandbox-venv/bin/pip     /usr/local/bin/pip \
    && ln -sf /opt/talos-sandbox-venv/bin/pip     /usr/local/bin/pip3

COPY sandboxd.py ./sandboxd.py
COPY entrypoint.sh ./entrypoint.sh

RUN mkdir -p /home/talos /var/lib/talos-sandbox
RUN chmod +x ./entrypoint.sh

EXPOSE 7800

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./entrypoint.sh"]
