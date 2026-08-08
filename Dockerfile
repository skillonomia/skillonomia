# The §9.1 quickstart image:
# `docker run -p 127.0.0.1:7431:7431 -v skillonomia-data:/data`.
#
# The host address in that `-p` is not decoration. This image sets
# SKILLONOMIA_HOST=0.0.0.0 below so the listener answers on the CONTAINER's
# network — a loopback bind inside a container is unreachable through any
# publish or proxy — and that bind is neither a TLS boundary nor a permission
# boundary. The boundary is where the port is published on the host, which is
# the operator's line, not this file's. A publish naming no host address maps
# this plain-HTTP listener onto every interface the host has, and the §9.1
# bootstrap token and every Bearer API key cross it in the clear. Serving
# another host is a different topology: no publish of this port at all, and a
# TLS-terminating reverse proxy in front (README → The network boundary,
# docs/OPERATIONS.md → The container: two decisions).
#
# Bun 1.3.14 is the canonical runtime (§2) and runs the TypeScript sources
# directly — there is no build step to go stale, and the image contains exactly
# the reviewed files plus the two runtime dependencies (ajv, ajv-formats).
# The base image is pinned BY DIGEST, not by tag. A tag is a mutable pointer:
# `oven/bun:1.3.14-slim` can be repushed, and then two builds of this identical
# Dockerfile produce two different images with nothing in the repository to show
# it. The digest is the content address of the manifest, so this line either
# resolves to those exact bytes or fails.
#
# The tag is kept in the comment because the digest alone says nothing to a
# reader. To move to a new base:
#
#   docker pull oven/bun:<tag>
#   docker image inspect oven/bun:<tag> --format '{{index .RepoDigests 0}}'
#
# and paste the result below. (`crane digest oven/bun:<tag>` and
# `docker buildx imagetools inspect oven/bun:<tag>` answer the same question
# without a local pull.)
FROM oven/bun@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
# ^ oven/bun:1.3.14-slim — the canonical runtime of §2

WORKDIR /app

# dependencies first, so a source edit does not re-resolve them
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# the reviewed sources and the data files they read at runtime
COPY src ./src
COPY migrations ./migrations
COPY schema ./schema
COPY seed ./seed
COPY README.md ./

# /data holds the SQLite file, the package blobs and the webhook secret store
RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
VOLUME ["/data"]

ENV SKILLONOMIA_DATA=/data \
    SKILLONOMIA_PORT=7431 \
    SKILLONOMIA_HOST=0.0.0.0

EXPOSE 7431

# Launch plus a /health smoke is the whole liveness contract of this image
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD bun --eval "const r = await fetch('http://127.0.0.1:' + (process.env.SKILLONOMIA_PORT ?? 7431) + '/health'); process.exit(r.ok ? 0 : 1)"

ENTRYPOINT ["bun", "run", "/app/src/cli.ts"]
CMD ["serve"]
