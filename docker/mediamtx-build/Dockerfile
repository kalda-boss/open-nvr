# MediaMTX for OpenNVR: the official v1.15.4 release built from source, plus
# the patches in ./patches (applied in order):
#
#   0001  rtsp: synchronize tracks with RTCP sender reports. Uniview (and
#         other) cameras stamp video RTP timestamps at the nominal frame rate
#         while the encoder runs slightly faster or slower, so video and audio
#         drift apart by seconds per hour and the recorder starts discarding
#         the lagging track ("received too late"). Upstream issue
#         https://github.com/bluenviron/mediamtx/issues/6160
#
# Everything the stage that produces the runtime image does is unchanged from
# the image that copied the official binary: curlimages/curl base, zoneinfo
# from postgres:15-alpine, /mediamtx entrypoint, config mounted at runtime.
#
# Build-time network access: GitHub (source tarball, hls.js and
# mediamtx-rpicamera, every download checksum-verified) and the Go module
# proxy (verified against go.sum). No apk/apt/pip.
#
# To update MediaMTX: bump MEDIAMTX_VERSION and MEDIAMTX_SHA256 (sha256 of
# https://github.com/bluenviron/mediamtx/archive/refs/tags/<version>.tar.gz),
# check that every patch still applies, and keep the Go toolchain on the
# version required by the new go.mod.

ARG MEDIAMTX_VERSION=v1.15.4
ARG MEDIAMTX_SHA256=614b611c216a62c5d9cca6ae554825d97cfbb6fd8c493cae74df160203b6bd35

FROM postgres:15-alpine AS tz-source

# The build stage runs on the build machine and cross-compiles for the target
# platform, so building linux/amd64 on Apple Silicon (or the reverse) works.
FROM --platform=$BUILDPLATFORM golang:1.25.14-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS mediamtx-build
ARG MEDIAMTX_VERSION
ARG MEDIAMTX_SHA256
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
WORKDIR /src
RUN curl -fsSL -o /tmp/mediamtx.tar.gz \
      "https://github.com/bluenviron/mediamtx/archive/refs/tags/${MEDIAMTX_VERSION}.tar.gz" \
 && echo "${MEDIAMTX_SHA256}  /tmp/mediamtx.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/mediamtx.tar.gz --strip-components=1 \
 && rm /tmp/mediamtx.tar.gz
COPY patches/ /patches/
RUN set -e; for p in /patches/*.patch; do git apply --verbose "$p"; done
RUN go mod download && go mod verify
# The release Makefile runs `go generate ./...`, whose version step needs a git
# checkout; write the version directly and run only the download steps.
RUN printf '%s' "${MEDIAMTX_VERSION}-opennvr" > internal/core/VERSION \
 && go generate ./internal/servers/hls/... ./internal/staticsources/rpicamera/...
# Unit tests of the patched package run on the build machine.
RUN go test ./internal/protocols/rtsp/
# Same flags as the official release binaries (static, upgrade command included).
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" GOARM="${TARGETVARIANT#v}" \
    go build -tags enableUpgrade -o /out/mediamtx .

# Base on curlimages/curl (working curl for the healthcheck +
# runOnInit hooks, no `apk add`), then copy in the statically-linked
# mediamtx binary. If you change the FROM line, re-audit inherited
# USER/WORKDIR/ENTRYPOINT/CMD/ENV so the boot doesn't silently break.
FROM curlimages/curl:8.10.1
USER root
WORKDIR /
# TZ=<IANA name> only takes effect if the zoneinfo database is present —
# without it the Go runtime silently falls back to UTC and recording
# directories get named in UTC while opennvr_core parses them in the
# configured zone. Copy the database out of postgres:15-alpine (already
# pinned and pulled by this stack, so no extra image) instead of
# `apk add tzdata`: an apk install makes every build of this image
# depend on the Alpine package CDN being reachable, and when it blips
# ("temporary error (try again later)") the whole stack fails to build.
# zoneinfo files are plain TZif data — arch- and libc-independent.
COPY --from=tz-source /usr/share/zoneinfo /usr/share/zoneinfo
# Clear any inherited CMD so it isn't passed to mediamtx as a config arg.
CMD []
COPY --from=mediamtx-build /out/mediamtx /mediamtx
ENTRYPOINT ["/mediamtx"]
