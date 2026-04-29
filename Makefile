# Makefile — VisionCore comandos rápidos

.PHONY: up down build logs restart seed migrate studio clean help

help: ## Mostrar esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

up: ## Levantar todos los servicios
	docker compose up -d

up-build: ## Rebuild y levantar
	docker compose up -d --build

down: ## Detener todos los servicios
	docker compose down

build: ## Construir imágenes
	docker compose build

logs: ## Ver logs en tiempo real
	docker compose logs -f --tail=100

logs-api: ## Ver logs del backend
	docker compose logs -f api --tail=100

logs-web: ## Ver logs del frontend
	docker compose logs -f web --tail=100

logs-mtx: ## Ver logs de MediaMTX
	docker compose logs -f mediamtx --tail=100

restart: ## Reiniciar todos los servicios
	docker compose restart

restart-api: ## Reiniciar solo el backend
	docker compose restart api

seed: ## Poblar base de datos con datos iniciales
	docker compose exec api npx tsx src/seed.ts

migrate: ## Ejecutar migraciones de DB
	docker compose exec api npx prisma migrate deploy

studio: ## Abrir Prisma Studio (explorador de DB)
	docker compose exec api npx prisma studio --port 5555

shell-api: ## Shell dentro del contenedor API
	docker compose exec api sh

shell-db: ## Shell en PostgreSQL
	docker compose exec postgres psql -U visioncore -d visioncore_db

clean: ## Eliminar contenedores y volúmenes (⚠️ BORRA DATOS)
	docker compose down -v --remove-orphans
	docker system prune -f

status: ## Estado de todos los servicios
	docker compose ps

.DEFAULT_GOAL := help
