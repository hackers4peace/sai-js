{ config, pkgs, lib, ... }:
let
  sai-oxigraph = pkgs.callPackage ./images/sai-oxigraph.nix { };
in
{
  virtualisation.podman.enable = true;
  virtualisation.podman.defaultNetwork.settings.dns_enabled = true;

  systemd.services.load-sai-oxigraph = {
    description = "Load sai-oxigraph image into Podman";
    wantedBy = [ "multi-user.target" ];
    wants = [ "podman-sparql.service" ];
    after = [ "network-online.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.podman}/bin/podman load -i ${sai-oxigraph}";
      RemainAfterExit = true;
    };
  };

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
        image = "docker.io/library/node:24-alpine";
        ports = ["3000:3000"];
        volumes = [
          "/home/elf-pavlik/code/solid/sai-js:/sai"
        ];
        environment = {
          DOMAIN = "id";
          CSS_SPARQL_ENDPOINT = "http://sparql/sparql";
        };
        cmd = ["node" "/sai/packages/id/http.ts"];
        dependsOn = ["sparql"];
      };
      caddy = {
        image = "docker.io/library/caddy:latest";
        ports = ["443:443"];
        volumes = [
          "/home/elf-pavlik/code/solid/sai-js/environments/lima/Caddyfile:/etc/caddy/Caddyfile"
        ];
        cmd = ["caddy" "run" "--config" "/etc/caddy/Caddyfile"];
      };
    };
  };
}
