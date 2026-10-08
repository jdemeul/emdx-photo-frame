# emdx-photo-frame — runs on a Synology NAS via Container Manager (tested on a DS420+),
# or anywhere with Docker (arm64 Macs included).
FROM node:22-bookworm-slim

# Fonts for the test pattern's labels; tzdata so TZ works for the schedule.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Europe/Brussels \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

VOLUME /data
EXPOSE 8321
HEALTHCHECK --interval=5m --timeout=10s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8321)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js", "serve"]
