.PHONY: setup up up-bundled-static forgejo-token logs down build

setup:
	./scripts/setup.sh

build:
	docker compose build

up:
	docker compose up -d forgejo opencode gameserver bot

up-bundled-static:
	docker compose --profile bundled-static up -d

forgejo-token:
	./scripts/bootstrap-forgejo.sh

logs:
	docker compose logs -f bot opencode gameserver forgejo

down:
	docker compose down
