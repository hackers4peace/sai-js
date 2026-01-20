{ config, pkgs, lib, ... }:
{
  virtualisation.podman.enable = true;
  virtualisation.podman.defaultNetwork.settings.dns_enabled = true;

  virtualisation.oci-containers = {
    backend = "podman";
    containers = {
      oxigraph = {
        image = "docker.io/oxigraph/oxigraph:latest";
        cmd = ["serve" "--location" "/data" "--bind" "0.0.0.0:7878"];
      };
      sparql = {
        image = "hackers4peace/sai-oxigraph:latest";
        ports = ["7878:80"];
        dependsOn = ["oxigraph"];
        environment = {
          NGINX_RESOLVER = "127.0.0.11";
        };
      };
      id = {
        image = "hackers4peace/sai-id:latest";
        ports = ["3000:3000"];
        dependsOn = ["sparql"];
        environment = {
          DOMAIN = "id";
          CSS_SPARQL_ENDPOINT = "http://sparql/sparql";
        };
      };
      caddy = {
        image = "docker.io/library/caddy:latest";
        ports = ["443:443"];
        volumes = [
          "/home/elf-pavlik/code/solid/sai-js/nix/Caddyfile:/etc/caddy/Caddyfile"
        ];
        cmd = ["caddy" "run" "--config" "/etc/caddy/Caddyfile"];
      };
    };
  };
}
