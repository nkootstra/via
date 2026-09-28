# syntax=docker/dockerfile:1

# Runs on the build machine's platform and cross-compiles via for the image's,
# so a multi-platform build needs no emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS build
ARG TARGETARCH
# The release workflow passes the version it tags; `via --version` prints it.
ARG VERSION=0.0.0
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun npm/set-version.ts "$VERSION"
# The admin UI, which the binary embeds from apps/web/dist.
RUN bun run --cwd apps/web build
# Baseline x64 runs on CPUs without AVX2 too, as some servers have.
RUN target=$([ "$TARGETARCH" = arm64 ] && echo linux-arm64 || echo linux-x64-baseline) \
 && bun build apps/cli/src/index.ts --compile --minify --target=bun-$target --outfile /out/via \
 && mkdir /out/data

# glibc and ca-certificates, no shell, and a non-root user.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /out/via /usr/local/bin/via
COPY --from=build --chown=65532:65532 /out/data /data
# Accounts, keys, config.yaml and cooldowns: mount a volume here to keep them.
ENV VIA_HOME=/data
VOLUME /data
EXPOSE 8317
ENTRYPOINT ["via"]
CMD ["serve", "--host", "0.0.0.0"]
