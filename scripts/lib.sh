#!/usr/bin/env bash
#
# Shared start/deploy helpers, sourced by start.sh and scripts/deploy.sh once
# they have cd'd to the repository root. Not a standalone script.

# Digest of every image-build input the scripts cannot see inside Docker: the
# code commit (tracked files sit exactly at HEAD after scripts/deploy.sh), the
# compose files (contexts, build args) and .env (build-arg values). Whoever
# last made every service image current for these inputs writes the stamp
# under untracked data/; while a fresh check matches it, builds are skipped.
IMAGE_STAMP="data/.image-build-stamp"

image_inputs_digest() {
  {
    git rev-parse HEAD 2>/dev/null || echo no-git
    sha256sum docker-compose.yml docker-compose.override.yml .env 2>/dev/null || true
  } | sha256sum | cut -d' ' -f1
}

images_stamped_current() {
  [[ -f "$IMAGE_STAMP" && "$(image_inputs_digest)" == "$(cat "$IMAGE_STAMP" 2>/dev/null)" ]]
}

stamp_images_current() {
  mkdir -p data
  image_inputs_digest >"$IMAGE_STAMP"
}

# A rebuild retags its service image, which strands the previous one as a
# dangling <none>; fully cached runs strand nothing, so this usually reclaims
# nothing.
prune_dangling_images() {
  docker image prune -f >/dev/null || echo " -> Could not prune dangling images." >&2
}
