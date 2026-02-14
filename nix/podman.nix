{ config, pkgs, lib, ... }:
let
  cfg = config.services.sai.containers;
  sai-id = pkgs.callPackage ./packages/sai-id.nix { };
  sai-css = pkgs.callPackage ./packages/sai-css.nix { };

  containers = {
    oxigraph = {
      image = "docker.io/oxigraph/oxigraph:latest";
      autoStart = true;
      cmd = ["serve" "--location" "/data" "--bind" "0.0.0.0:7878"];
    };
    sparql = {
      image = "quay.io/hackers4peace/sai-oxigraph:${cfg.sparql.tag}";
      autoStart = true;
      ports = ["7878:80"];
      environment = {
        NGINX_RESOLVER = cfg.sparql.resolver;
      };
    };
    id = {
      image = "quay.io/hackers4peace/sai-id:${cfg.id.tag}";
      autoStart = true;
      ports = ["3000:3000"];
      environment = {
        ID_ORIGIN = cfg.id.idOrigin;
        DOC_ORIGIN = cfg.id.docOrigin;
        CSS_SPARQL_ENDPOINT = "http://sparql/sparql";
      };
    };

    postgresql = {
      image = "docker.io/library/postgres:${cfg.postgres.version}";
      autoStart = true;

      ports = [ "5432:5432" ];

      environment = {
        POSTGRES_USER = "temporal";
        POSTGRES_PASSWORD = "temporal";
      };

      volumes = [
        "postgresql-data:/var/lib/postgresql/data"
      ];
    };

    temporal-admin-tools = {
      image = "docker.io/temporalio/admin-tools:${cfg.temporal.adminToolsVersion}";
      autoStart = true;

      extraOptions = [
        "--entrypoint=/bin/sh"
      ];

      cmd = [
        "-c"
        ''
          set -e
          until pg_isready -h postgresql -U temporal; do
            sleep 2
          done
          sh /etc/temporal/setup-postgres.sh
        ''
      ];

      environment = {
        DB = "postgres12";
        DB_PORT = "5432";
        POSTGRES_USER = "temporal";
        POSTGRES_PWD = "temporal";
        POSTGRES_SEEDS = "postgresql";
        SQL_PASSWORD = "temporal";
      };

      volumes = [
        "${cfg.temporal.setupPostgresScript}:/etc/temporal/setup-postgres.sh:ro"
      ];
    };

    temporal = {
      image = "docker.io/temporalio/server:${cfg.temporal.version}";
      autoStart = true;

      ports = [ "7233:7233" ];

      environment = {
        DB = "postgres12";
        DB_PORT = "5432";
        POSTGRES_USER = "temporal";
        POSTGRES_PWD = "temporal";
        POSTGRES_SEEDS = "postgresql";
        BIND_ON_IP = "0.0.0.0";
        DYNAMIC_CONFIG_FILE_PATH = "/etc/temporal/development-sql.yaml";
      };

      volumes = [
        "${cfg.temporal.dynamicConfig}:/etc/temporal/development-sql.yaml:ro"
      ];
    };

    temporal-create-namespace = {
      image = "docker.io/temporalio/admin-tools:${cfg.temporal.adminToolsVersion}";
      autoStart = true;

      extraOptions = [
        "--entrypoint=/bin/sh"
      ];

      cmd = [
        "-c"
        ''
        until nc -z temporal 7233; do
          sleep 2
        done
        sh /etc/temporal/create-namespace.sh
        ''
      ];

      environment = {
        TEMPORAL_ADDRESS = "temporal:7233";
        DEFAULT_NAMESPACE = "default";
      };

      volumes = [
        "${cfg.temporal.createNamespaceScript}:/etc/temporal/create-namespace.sh:ro"
      ];
    };

    temporal-ui = {
      image = "docker.io/temporalio/ui:${cfg.temporal.uiVersion}";
      autoStart = true;

      ports = [ "8080:8080" ];

      environment = {
        TEMPORAL_ADDRESS = "temporal:7233";
        TEMPORAL_CORS_ORIGINS = "http://localhost:3000";
      };
    };

    auth = {
      image = "quay.io/hackers4peace/sai-css:${cfg.auth.tag}";
      autoStart = true;
      ports = ["4800:4800"];
      environment = {
        CSS_SPARQL_ENDPOINT = "http://sparql/sparql";
        CSS_POSTGRES_CONNECTION_STRING = "postgres://temporal:temporal@postgresql:5432/auth";
        CSS_CONFIG = "/config/auth.json";
        CSS_BASE_URL = cfg.auth.baseUrl;
        CSS_AUTHORIZATION_ENDPOINT = cfg.auth.authEndpoint;
        CSS_PORT = "4800";
        TEMPORAL_ADDRESS = "temporal:7233";
        CSS_VAPID_PUBLIC_KEY = cfg.auth.vapidPublicKey;
        CSS_ID_ORIGIN = cfg.auth.idOrigin;
        CSS_DOC_ORIGIN = cfg.auth.docOrigin;
        CSS_DATA_ORIGIN = cfg.auth.dataOrigin;
        CSS_REG_ORIGIN = cfg.auth.regOrigin;
        SSL_CERT_FILE = "/etc/ssl/certs/ca-bundle.crt";
      };
      environmentFiles = [
        cfg.auth.env
      ];
      volumes = [
        "${cfg.auth.config}:/config/auth.json:ro"
      ];
    };

    registry = {
      image = "quay.io/hackers4peace/sai-css:${cfg.registry.tag}";
      autoStart = true;
      ports = ["4600:4600"];
      environment = {
        CSS_SPARQL_ENDPOINT = "http://sparql/sparql";
        CSS_POSTGRES_CONNECTION_STRING = "postgres://temporal:temporal@postgresql:5432/auth";
        CSS_CONFIG = "/config/registry.json";
        CSS_BASE_URL = cfg.registry.baseUrl;
        CSS_PORT = "4600";
        SSL_CERT_FILE = "/etc/ssl/certs/ca-bundle.crt";
      };
      volumes = [
        "${cfg.registry.config}:/config/registry.json:ro"
      ];
    };

    data = {
      image = "quay.io/hackers4peace/sai-css:${cfg.data.tag}";
      autoStart = true;
      ports = ["4700:4700"];
      environment = {
        CSS_SPARQL_ENDPOINT = "http://sparql/sparql";
        CSS_POSTGRES_CONNECTION_STRING = "postgres://temporal:temporal@postgresql:5432/auth";
        CSS_CONFIG = "/config/data.json";
        CSS_ROOT_FILE_PATH = "/data";
        CSS_BASE_URL = cfg.data.baseUrl;
        CSS_PORT = "4700";
        SSL_CERT_FILE = "/etc/ssl/certs/ca-bundle.crt";
      };
      volumes = [
        "${cfg.data.config}:/config/data.json:ro"
        "css-data:/data"
      ];
    };
  };

  containerNames = lib.filter (name: !lib.elem name ["temporal-admin-tools" "temporal-create-namespace"])
    (builtins.attrNames containers);
in
{
  options.services.sai.containers = {
    postgres = {
      version = lib.mkOption {
        type = lib.types.str;
        default = "16";
        description = "postgres image version";
      };
    };
    temporal = {
      version = lib.mkOption {
        type = lib.types.str;
        default = "1.29.1";
        description = "temporal image version";
      };
      uiVersion = lib.mkOption {
        type = lib.types.str;
        default = "2.34.0";
        description = "temporal-ui image version";
      };
      adminToolsVersion = lib.mkOption {
        type = lib.types.str;
        default = "1.29.1-tctl-1.18.4-cli-1.5.0";
        description = "temporal-admin-tools image version";
      };
      dynamicConfig = lib.mkOption {
        type = lib.types.path;
        default = ../temporal/development.yaml;
        description = "temporal config";
      };
      setupPostgresScript = lib.mkOption {
        type = lib.types.path;
        default = ../temporal/setup-postgres.sh;
        description = "temporal postgres setup";
      };
      createNamespaceScript = lib.mkOption {
        type = lib.types.path;
        default = ../temporal/create-namespace.sh;
        description = "temporal namespace setup";
      };
    };

    id = {
      tag = lib.mkOption {
        type = lib.types.str;
        default = sai-id.version;
        description = "sai-id image tag";
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
    auth = {
      tag = lib.mkOption {
        type = lib.types.str;
        default = sai-css.version;
        description = "sai-css image tag";
      };
      baseUrl = lib.mkOption {
        type = lib.types.str;
      };
      authEndpoint = lib.mkOption {
        type = lib.types.str;
      };
      idOrigin = lib.mkOption {
        type = lib.types.str;
      };
      docOrigin = lib.mkOption {
        type = lib.types.str;
      };
      dataOrigin = lib.mkOption {
        type = lib.types.str;
      };
      regOrigin = lib.mkOption {
        type = lib.types.str;
      };
      vapidPublicKey = lib.mkOption {
        type = lib.types.str;
      };
      env = lib.mkOption {
        type = lib.types.path;
        description = "auth service env";
      };
      config = lib.mkOption {
        type = lib.types.path;
        default = ../services/css/auth.json;
        description = "auth service config";
      };
    };
    registry = {
      tag = lib.mkOption {
        type = lib.types.str;
        default = sai-css.version;
        description = "sai-css image tag";
      };
      baseUrl = lib.mkOption {
        type = lib.types.str;
      };
      config = lib.mkOption {
        type = lib.types.path;
        default = ../services/css/registry.json;
        description = "registry service config";
      };
    };
    data = {
      tag = lib.mkOption {
        type = lib.types.str;
        default = sai-css.version;
        description = "sai-css image tag";
      };
      baseUrl = lib.mkOption {
        type = lib.types.str;
      };
      config = lib.mkOption {
        type = lib.types.path;
        default = ../services/css/data.json;
        description = "data service config";
      };
    };
  };

  config = {
    virtualisation.podman = {
      enable = true;
      defaultNetwork.settings.dns_enabled = true;
    };

    virtualisation.oci-containers = {
      backend = "podman";
      inherit containers;
    };
    systemd.services = lib.listToAttrs (map (name: {
      name = "podman-${name}";
      value = {
        serviceConfig = {
          Restart = lib.mkDefault "always";
          RestartSec = lib.mkDefault 20;
          StartLimitBurst = lib.mkDefault 4;
        };
      };
    }) containerNames) // {
      "podman-temporal-admin-tools" = {
        serviceConfig = {
          Restart = lib.mkForce "no";
        };
      };
      "podman-temporal-create-namespace" = {
        serviceConfig = {
          Restart = lib.mkForce "no";
        };
      };
    };
  };
}

