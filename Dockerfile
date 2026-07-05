# glibc ベース（slim）。better-sqlite3 のプリビルドがそのまま効き、ネイティブビルド不要。
# （alpine=musl だとプリビルドが合わず、ソースビルドに python3/make/g++ が必要になる）
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
