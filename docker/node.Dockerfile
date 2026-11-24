# syntax=docker/dockerfile:1
# BAHITH Node services (web, jobs, migrate) from one monorepo build. Images carry no
# secrets: every credential is supplied at run time through the environment. An extra
# CA (e.g. a corporate proxy) can be given to the build only, as the "extra_ca" secret.
FROM node:22.23.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN --mount=type=secret,id=extra_ca,required=false \
    NODE_EXTRA_CA_CERTS=$([ -s /run/secrets/extra_ca ] && echo /run/secrets/extra_ca) \
    sh -c 'corepack enable && corepack prepare pnpm@10.28.0 --activate'
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=secret,id=extra_ca,required=false \
    NODE_EXTRA_CA_CERTS=$([ -s /run/secrets/extra_ca ] && echo /run/secrets/extra_ca) \
    sh -c 'pnpm install --frozen-lockfile && pnpm --filter @bahith/web build'

FROM base AS runtime
# pg_dump/pg_restore 16 for the backup CLI (same major as the server), from PGDG.
RUN --mount=type=secret,id=extra_ca,required=false \
    sed -i 's#http://deb.debian.org#https://deb.debian.org#g' /etc/apt/sources.list.d/debian.sources \
 && if [ -s /run/secrets/extra_ca ]; then \
      install -m 0644 /run/secrets/extra_ca /tmp/extra-ca.crt \
      && echo 'Acquire::https::CAInfo "/tmp/extra-ca.crt";' > /etc/apt/apt.conf.d/99extra-ca; fi \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsS $( [ -s /tmp/extra-ca.crt ] && echo --cacert /tmp/extra-ca.crt ) \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update -qq && apt-get install -y -qq --no-install-recommends postgresql-client-16 \
 && apt-get purge -y -qq curl gnupg && apt-get autoremove -y -qq \
 && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99extra-ca /tmp/extra-ca.crt
ENV PATH=/usr/lib/postgresql/16/bin:$PATH NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node

FROM runtime AS web
EXPOSE 3000
CMD ["pnpm", "--filter", "@bahith/web", "exec", "next", "start", "-p", "3000", "-H", "0.0.0.0"]

FROM runtime AS jobs
CMD ["pnpm", "--filter", "@bahith/jobs", "start"]

FROM runtime AS migrate
# --allow-remote: the database is another container/host. Run it only against staging or,
# with the owner's written approval, production.
CMD ["pnpm", "--filter", "@bahith/db", "exec", "tsx", "src/cli/migrate.ts", "--allow-remote"]
