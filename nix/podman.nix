{ config, pkgs, lib, ... }:
let
  cfg = config.services.sai.containers;
in
{
  options.services.sai.containers = {
    id = {
      tag = lib.mkOption {
        type = lib.types.str;
        default = "latest";
        description = "sai-id image tag";
      };
      sparqlEndpoint = lib.mkOption {
        type = lib.types.str;
        default = "http://sparql/sparql";
      };
    };
    sparql = {
      tag = lib.mkOption {
        type = lib.types.str;
        default = "latest";
        description = "sai-oxigraph image tag";
      };
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
          image = "hackers4peace/sai-oxigraph:${cfg.sparql.tag}";
          ports = ["7878:80"];
          dependsOn = ["oxigraph"];
          environment = {
            NGINX_RESOLVER = cfg.sparql.resolver;
          };
        };
        id = {
          image = "hackers4peace/sai-id:${cfg.id.tag}";
          ports = ["3000:3000"];
          dependsOn = ["sparql"];
          environment = {
            ID_ORIGIN = cfg.id.idOrigin;
            DOC_ORIGIN = cfg.id.docOrigin;
            CSS_SPARQL_ENDPOINT = cfg.id.sparqlEndpoint;
          };
        };
      };
    };
  };
}
