# sw-saas-platform
#
# `make demo` is the one command. Everything else is a convenience.
#
# Windows: use `docker compose up --build` and the npm scripts directly, or run these
# from Git Bash / WSL. Every target below is a thin wrapper around a command you can run
# by hand — nothing here is load-bearing.

SHELL := /bin/bash
COMPOSE := docker compose

.DEFAULT_GOAL := help
.PHONY: help demo up down reset logs ps migrate seed test test-isolation verify-isolation \
        typecheck build dev-api dev-web kind-up kind-test kind-down loadtest \
        tf-init tf-plan tf-apply teardown clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

## ---------------------------------------------------------------- the demo

demo: ## Build and run the whole stack (the one command)
	$(COMPOSE) up --build

up: ## Start the stack in the background
	$(COMPOSE) up -d --build
	@echo ""
	@echo "  web         http://localhost:3000"
	@echo "  api         http://localhost:4000"
	@echo "  graphql     http://localhost:4000/graphql"
	@echo "  dev idp     http://localhost:4010"
	@echo "  prometheus  http://localhost:9090"
	@echo "  grafana     http://localhost:3001  (anonymous viewer access)"
	@echo ""

down: ## Stop the stack, keeping data
	$(COMPOSE) down

reset: ## Stop the stack and DELETE the database and cache volumes
	$(COMPOSE) down -v

logs: ## Tail logs from the API
	$(COMPOSE) logs -f api

ps: ## Show container status
	$(COMPOSE) ps

## ------------------------------------------------------------- development

deps: ## Start only Postgres and Redis, for running the apps on the host
	$(COMPOSE) up -d postgres redis

migrate: deps ## Apply database migrations
	npm run migrate

seed: ## Insert the demo tenants
	npm run seed

dev-api: ## Run the API on the host with reload
	npm run dev:api

dev-web: ## Run the front end on the host with reload
	npm run dev:web

typecheck: ## Typecheck every workspace
	npm run typecheck --workspaces --if-present

build: ## Build every workspace
	npm run build --workspaces --if-present

## ------------------------------------------------------------------ tests

test: deps ## Run the full test suite
	npm test

test-isolation: deps ## Run only the cross-tenant isolation tests
	npm run test:isolation

verify-isolation: deps ## Prove the isolation tests fail when RLS is removed
	node scripts/verify-isolation.mjs

## ------------------------------------------------------- kubernetes (kind)

kind-up: ## Run the dev overlay on kind with Calico, External Secrets and LocalStack
	scripts/kind/up.sh

kind-test: ## NetworkPolicy checks and isolation tests against the in-cluster API
	scripts/kind/netpol-check.sh
	scripts/kind/isolation-tests.sh

kind-down: ## Delete the kind cluster
	scripts/kind/up.sh --down

loadtest: ## k6 load test against the API in docker compose (set RUNNER_LABEL)
	loadtest/run.sh

## ------------------------------------------------------------ infrastructure

tf-init: ## terraform init for the dev environment
	cd infra/terraform/envs/dev && terraform init

tf-plan: ## terraform plan for the dev environment (costs nothing)
	cd infra/terraform/envs/dev && terraform plan

tf-apply: ## terraform apply for the dev environment (THIS COSTS MONEY — read docs/cost.md)
	@echo "This provisions real AWS resources. Estimated ~\$$260/month for dev."
	@echo "Read docs/cost.md first. Ctrl-C to abort."
	@sleep 5
	cd infra/terraform/envs/dev && terraform apply

teardown: ## Destroy all AWS resources (see docs/teardown.md)
	@echo "Destroying the dev environment."
	cd infra/terraform/envs/dev && terraform destroy

clean: ## Remove build output and node_modules
	rm -rf node_modules apps/*/node_modules packages/*/node_modules \
	       apps/*/dist packages/*/dist apps/web/.next apps/api/test-results
