FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/zawa-server ./cmd/server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
WORKDIR /app
COPY --from=build /out/zawa-server /app/zawa-server
ENV HOST=0.0.0.0 PORT=3000 SQLITE_PATH=/data/zawa.sqlite FRONTEND_PORT=5173
RUN mkdir -p /data && chown app:app /data
USER app
EXPOSE 3000
ENTRYPOINT ["/app/zawa-server"]
