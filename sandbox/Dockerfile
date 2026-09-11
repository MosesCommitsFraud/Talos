# trixie (Debian 13) ships Python 3.13 — the pinned numpy/scipy/scikit-learn
# generation (numpy>=2.5) requires Python >=3.12, which bookworm's 3.11 can't satisfy.
FROM node:22-trixie-slim

# Same CDN-resilience treatment as the app image (see the long note there): the
# Fastly mirror resets connections under apt's default pipelining, and this
# package list is far larger, so it's the more likely of the two to be bitten.
RUN set -eu; \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
        'Acquire::Retries "5";' \
        'Acquire::http::Pipeline-Depth "0";' \
        'Acquire::https::Pipeline-Depth "0";' \
        > /etc/apt/apt.conf.d/99-talos-apt-resilience; \
    apt-get update -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false; \
    apt-get install -y --no-install-recommends \
        -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false \
        ca-certificates; \
    ok=0; \
    for attempt in 1 2 3; do \
        if apt-get update && apt-get install -y --no-install-recommends \
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
    fonts-crosextra-caladea \
    fonts-crosextra-carlito \
    fonts-liberation \
    gfortran \
    git \
    gosu \
    htop \
    imagemagick \
    iputils-ping \
    jq \
    less \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
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
    zip; \
        then ok=1; break; fi; \
        echo "apt install failed (attempt $attempt/3), retrying in 10s"; \
        sleep 10; \
    done; \
    [ "$ok" = 1 ]; \
    rm -rf /var/lib/apt/lists/*

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

# Vendored dashboard libraries. The sandbox has NO network access at runtime, so
# a generated HTML dashboard cannot pull a chart library from a CDN — the page
# would render blank in the preview iframe and in any browser without internet.
# Baking the library in at build time (where there IS network) lets a dashboard
# inline it and be genuinely self-contained.
#
# TanStack Charts is ESM-only and ships no UMD build, so unlike a drop-in
# <script> library it has to be bundled here. `charts/entry.mjs` is the Talos
# runtime — it imports the marks, scales and layouts the catalog actually uses
# and exposes one global — and esbuild folds it and the library into a single
# IIFE that talos_dash.py inlines verbatim. Bundling only what the catalog
# reaches for is also why the result is half the size of the ECharts UMD build
# it replaces.
#
# Two things get vendored, not just the bundle:
#   talos-charts.js   the IIFE (window.TalosCharts), inlined into every dashboard
#   tanstack-charts-docs/  the library's own docs and agent skills (~1 MB of
#                     markdown). The sandbox has no network, so this is the
#                     offline reference: grepping it is how the model confirms a
#                     mark's option name without guessing, the way echarts.d.ts
#                     used to serve.
#
# The version is pinned exactly. TanStack Charts is Alpha — minor releases may
# contain breaking API changes — so an unpinned rebuild could silently produce
# an image whose runtime no longer matches this repo's entry.mjs.
ARG TANSTACK_CHARTS_VERSION=0.16.0
COPY vendor/charts/entry.mjs /tmp/charts/entry.mjs
RUN set -eu; \
    mkdir -p /opt/talos/vendor; \
    cd /tmp/charts; \
    npm install --no-audit --no-fund --no-save \
        "@tanstack/charts@${TANSTACK_CHARTS_VERSION}" d3-scale d3-shape esbuild; \
    ./node_modules/.bin/esbuild entry.mjs \
        --bundle --format=iife --global-name=TalosCharts --minify --target=es2020 \
        --outfile=/opt/talos/vendor/talos-charts.js; \
    cp -r node_modules/@tanstack/charts/docs /opt/talos/vendor/tanstack-charts-docs; \
    cp -r node_modules/@tanstack/charts/skills /opt/talos/vendor/tanstack-charts-docs/skills; \
    printf '%s\n' "${TANSTACK_CHARTS_VERSION}" > /opt/talos/vendor/tanstack-charts.version; \
    node -e "const s=require('fs').readFileSync('/opt/talos/vendor/talos-charts.js','utf8'); if(!/TalosCharts/.test(s)||s.length<100000) throw new Error('bundle looks wrong: '+s.length+' bytes')"; \
    rm -rf /tmp/charts /root/.npm; \
    chmod -R a+rX /opt/talos

# The dashboard scaffold: HTML shell, grid, KPI tiles, theming, per-chart error
# isolation, plus a catalog of chart builders. All of it is identical for every
# dashboard ever requested, so shipping it here means the model emits only the
# chart choices and the data instead of regenerating ~400 lines of boilerplate
# per request — the single largest latency cost of a dashboard turn.
COPY vendor/talos_dash.py /opt/talos/vendor/talos_dash.py
COPY vendor/echarts-runtime.js /opt/talos/vendor/echarts-runtime.js
COPY vendor/dashboard-view.js /opt/talos/vendor/dashboard-view.js

# Full Apache ECharts is the primary dashboard API. Keep the old builders for
# existing dashboards; render() only inlines the engines a page actually uses.
ARG ECHARTS_VERSION=6.1.0
ARG ECHARTS_EXAMPLES_REVISION=ef748beb99604435cc230974ab8f07dc3b01e6b2
COPY vendor/charts/index_examples.py /tmp/index_examples.py
RUN set -eu; \
    mkdir -p /tmp/echarts; cd /tmp/echarts; \
    npm install --no-audit --no-fund --no-save \
        "echarts@${ECHARTS_VERSION}" echarts-gl@2.1.0 echarts-stat@1.2.0 html-to-image@1.11.13; \
    cp node_modules/html-to-image/dist/html-to-image.js /opt/talos/vendor/html-to-image.js; \
    cp node_modules/html-to-image/LICENSE /opt/talos/vendor/html-to-image.LICENSE; \
    cp node_modules/echarts/dist/echarts.min.js /opt/talos/vendor/echarts.min.js; \
    printf '\n;\n' >> /opt/talos/vendor/echarts.min.js; \
    cat node_modules/echarts/i18n/langDE.js >> /opt/talos/vendor/echarts.min.js; \
    cp node_modules/echarts/index.d.ts /opt/talos/vendor/echarts-index.d.ts; \
    cp -r node_modules/echarts/types /opt/talos/vendor/echarts-types; \
    cp node_modules/echarts-gl/dist/echarts-gl.min.js /opt/talos/vendor/echarts-gl.min.js; \
    cp node_modules/echarts-stat/dist/ecStat.min.js /opt/talos/vendor/echarts-stat.min.js; \
    cp node_modules/echarts-stat/package.json /opt/talos/vendor/echarts-stat.package.json; \
    cp node_modules/echarts-stat/README.md /opt/talos/vendor/echarts-stat.README.md; \
    for package in echarts echarts-gl; do \
        cp "node_modules/$package/LICENSE" "/opt/talos/vendor/$package.LICENSE"; \
    done; \
    printf '%s\n' "${ECHARTS_VERSION}" > /opt/talos/vendor/echarts.version; \
    git init /tmp/echarts-examples; cd /tmp/echarts-examples; \
    git remote add origin https://github.com/apache/echarts-examples.git; \
    git sparse-checkout init --cone; \
    git sparse-checkout set public/examples public/data/asset; \
    git fetch --depth 1 --filter=blob:none origin "${ECHARTS_EXAMPLES_REVISION}"; \
    git checkout --detach FETCH_HEAD; \
    mkdir -p /opt/talos/vendor/echarts-examples; \
    cp -r public LICENSE /opt/talos/vendor/echarts-examples/; \
    printf '%s\n' "${ECHARTS_EXAMPLES_REVISION}" > /opt/talos/vendor/echarts-examples/REVISION; \
    python /tmp/index_examples.py /opt/talos/vendor/echarts-examples; \
    rm -rf /tmp/echarts /tmp/echarts-examples /tmp/index_examples.py /root/.npm
RUN chmod -R a+rX /opt/talos

COPY sandboxd.py ./sandboxd.py
COPY entrypoint.sh ./entrypoint.sh

RUN mkdir -p /home/talos /var/lib/talos-sandbox
RUN chmod +x ./entrypoint.sh

EXPOSE 7800

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./entrypoint.sh"]
