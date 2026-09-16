# Image build graph for CI and releases.
#
# CI builds every target in parallel (`docker buildx bake`), smoke-tests the
# images, and exports the `release` group as the artifact the tk104 deploy
# loads. Locally: `TAG=dev docker buildx bake --load release`.

variable "TAG" {
  default = "local"
}

group "default" {
  targets = ["api", "web", "workers", "caddy-tk104", "rnsquadjs"]
}

# What a tk104 release runs; compose.tk104.yml references these names.
group "release" {
  targets = ["api", "web", "workers", "caddy-tk104"]
}

target "api" {
  context    = "."
  dockerfile = "docker/api.Dockerfile"
  tags       = ["squad-panel/api:${TAG}"]
}

target "web" {
  context    = "."
  dockerfile = "docker/web.Dockerfile"
  tags       = ["squad-panel/web:${TAG}"]
}

target "workers" {
  context    = "."
  dockerfile = "docker/worker.Dockerfile"
  tags       = ["squad-panel/workers:${TAG}"]
}

target "caddy-tk104" {
  context    = "."
  dockerfile = "docker/caddy-duckdns.Dockerfile"
  tags       = ["squad-panel/caddy-tk104:${TAG}"]
}

# The per-server sidecar is launched by the bridge from a host-built image and
# is not part of a release; CI builds it so a broken Dockerfile fails early.
target "rnsquadjs" {
  context    = "."
  dockerfile = "docker/rnsquadjs.Dockerfile"
  tags       = ["squad-panel/rnsquadjs:${TAG}"]
}
