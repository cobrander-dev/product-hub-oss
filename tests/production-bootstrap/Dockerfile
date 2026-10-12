ARG MIGRATOR_IMAGE
FROM docker:29-cli AS docker-tools
FROM ${MIGRATOR_IMAGE}
USER root
COPY --from=docker-tools /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-tools /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY compose.yaml compose.production.yaml compose.hard-delete.yaml compose.bootstrap.yaml .env.production.example ./
COPY deploy/templates ./deploy/templates
COPY deploy/releases ./deploy/releases
COPY docker/postgres/init-production ./docker/postgres/init-production
COPY scripts/backup.sh ./scripts/backup.sh
COPY scripts/backup-connection.mjs ./scripts/backup-connection.mjs
COPY scripts/verify-production-image-architecture.sh ./scripts/verify-production-image-architecture.sh
COPY scripts/installer ./scripts/installer
COPY tests/production-bootstrap/controller.ts ./tests/production-bootstrap/controller.ts
ENTRYPOINT ["node", "./node_modules/tsx/dist/cli.mjs", "tests/production-bootstrap/controller.ts"]
