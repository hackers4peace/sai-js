{ config, pkgs, lib, ... }:
let
  cfg = config.services.sai.containers;
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
    virtualisation.podman = {
      enable = true;
      defaultNetwork.settings.dns_enabled = true;
    };

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

          dependsOn = [ "postgresql" ];

          cmd = [
            "sh" "-c"
            ''
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

          dependsOn = [ "temporal-admin-tools" ];
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

          dependsOn = [ "temporal" ];

          cmd = [
            "sh" "-c"
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

          dependsOn = [ "temporal" ];
          ports = [ "8080:8080" ];

          environment = {
            TEMPORAL_ADDRESS = "temporal:7233";
            TEMPORAL_CORS_ORIGINS = "http://localhost:3000";
          };
        };
      };
    };
  };
}

