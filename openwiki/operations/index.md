# Files

- [Production deployment and observability](deployment.md) - The NixOS/Podman VPS deployment (nixos-anywhere, flake hosts, ragenix-encrypted secrets, Caddy reverse proxy) and the OpenTelemetry env contract, mechanics, and Tempo/Grafana observability path for sai-js.
- [Local development environment](development.md) - The Docker Compose dev stack (auth, registry, data, worker, ui, vuejectron, router, dns, temporal, fuseki, garage, tempo, grafana), wildcard *.docker DNS via dnsmasq, mkcert TLS, Node 26, and the per-pod devbox seed workflow.
