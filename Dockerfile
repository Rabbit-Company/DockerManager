FROM oven/bun:1 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/dist/controller /src/dist/agent-linux-x64 /src/dist/agent-linux-arm64 /app/dist/
ENV DATABASE_URL=sqlite:///data/controller.sqlite \
	SECRETS_KEY_FILE=/data/secret.key \
	AGENT_DOWNLOADS=/app/dist \
	PORT=3000
RUN mkdir /data && chown 1000:1000 /data
VOLUME /data
EXPOSE 3000
USER 1000:1000
CMD ["/app/dist/controller"]
