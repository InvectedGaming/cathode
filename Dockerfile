# Phospharr — self-hosted IPTV manager + viewer (Bun + ffmpeg w/ NVENC)
#
# Debian (glibc) base, NOT Alpine: NVENC needs the NVIDIA driver libraries the
# container toolkit injects at runtime, and those are glibc — they can't load
# under musl. With this base + a GPU grant in compose (+ PHOSPHARR_CAST_ENCODER=
# h264_nvenc) the mosaic compositor / transcoder encode on the GPU.
FROM oven/bun:1-debian

# Native-VPN helpers (no Gluetun): openvpn + iproute2 run OpenVPN tunnels with
# per-source policy routing; iptables; microsocks is the per-tunnel SOCKS proxy;
# wireproxy (fetched below) runs WireGuard in userspace. curl/xz fetch ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openvpn iproute2 iptables ca-certificates curl gnupg xz-utils git build-essential \
 && rm -rf /var/lib/apt/lists/*

# NVENC-capable ffmpeg, MATCHED TO THE HOST DRIVER. The BtbN "latest" build needs
# NVENC API 13.1 (driver 610+); this host is on 535 (API 12.1). jellyfin-ffmpeg6
# is built for broad driver compatibility (NVENC 12.x), so it works on 535. It
# dlopens the NVIDIA libs the container toolkit injects; falls back to libx264 with
# no GPU. Symlinked into PATH; FFMPEG_PATH points the app at it.
RUN mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
 && . /etc/os-release \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/jellyfin.list \
 && apt-get update && apt-get install -y --no-install-recommends jellyfin-ffmpeg6 \
 && ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
 && ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
 && rm -rf /var/lib/apt/lists/*

# microsocks isn't conveniently packaged — build the tiny single-file proxy.
RUN git clone --depth 1 https://github.com/rofl0r/microsocks /tmp/microsocks \
 && make -C /tmp/microsocks \
 && install -m0755 /tmp/microsocks/microsocks /usr/local/bin/microsocks \
 && rm -rf /tmp/microsocks

WORKDIR /app

# Install deps first so the layer caches across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source (drizzle/ migrations included; .dockerignore keeps the dev DB out).
COPY . .

# Fetch the wireproxy helper into ./bin (best-effort — see vpn:helpers).
RUN bun run vpn:helpers || echo "[build] wireproxy not fetched — set PHOSPHARR_WIREPROXY or run 'bun run vpn:helpers'"

# DB + DVR live on a mounted volume so they survive container rebuilds.
ENV DATABASE_URL=/data/phospharr.db \
    PHOSPHARR_DVR_PATH=/data/dvr \
    PORT=7777 \
    NODE_ENV=production \
    FFMPEG_PATH=/usr/local/bin/ffmpeg
VOLUME /data
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7777/robots.txt >/dev/null 2>&1 || exit 1

# Apply any pending migrations on boot, then serve.
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
