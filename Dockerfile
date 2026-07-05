# glibc ベース（slim）。musl(alpine) だと better-sqlite3 のプリビルドが合わない。
FROM node:20-slim
WORKDIR /app
# better-sqlite3 のネイティブビルド用ツール。プリビルドが使えない環境でも
# ソースビルドで通るようにする（node-gyp が python3 / make / g++ を要求する）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
