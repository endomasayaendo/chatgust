# 開発用コマンドの入口。中身は docker compose と npm scripts を呼ぶだけ。
# `make`（= make help）で一覧を表示する。

.DEFAULT_GOAL := help
.PHONY: help setup up down auth test typecheck

COMPOSE := docker compose
# --build: package.json が変わっていればイメージを作り直す（変わっていなければキャッシュで一瞬）
RUN := $(COMPOSE) run --rm --build app

help: ## コマンド一覧
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'

setup: ## .env を用意し、足りない値と取得場所を表示
	@test -f .env || (cp .env.example .env && echo ".env を .env.example から作成しました")
	@$(RUN) npx tsx scripts/checkEnv.ts

up: ## 起動（ソース保存で自動再起動 / Ctrl+C で終了）
	@# -V: node_modules をイメージのものに入れ直す（package.json 変更後も古いまま残らない）
	$(COMPOSE) up --build -V --watch

down: ## 停止してコンテナを片付ける
	$(COMPOSE) down -v

auth: ## Twitch にログインしてトークンを .env に保存
	$(COMPOSE) run --rm --build -p 22377:22377 app npm run auth

test: ## テスト
	$(RUN) npm test

typecheck: ## 型チェック
	$(RUN) npm run typecheck
