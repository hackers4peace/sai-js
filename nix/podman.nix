{ config, pkgs, lib, ... }:
let
  cfg = config.services.sai.containers;
in
{
  options.services.sai.containers = {
    id = {
      sparqlEndpoint = lib.mkOption {
        type = lib.types.str;
        default = "http://sparql/sparql";
      };
    };
    sparql = {
      resolver = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.11";
      };
    };
  };

  config = {
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
            NGINX_RESOLVER = cfg.sparql.resolver;
          };
        };
        id = {
          image = "hackers4peace/sai-id:latest";
          ports = ["3000:3000"];
          dependsOn = ["sparql"];
          environment = {
            DOMAIN = cfg.id.domain;
            CSS_SPARQL_ENDPOINT = cfg.id.sparqlEndpoint;
          };
        };
      };
    };
  };
}
