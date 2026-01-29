{ config, pkgs, lib, ... }:
let
  cfg = config.services.sai.containers;
in
{
  options.services.sai.containers = {
    id = {
      idOrigin = lib.mkOption {
        type = lib.types.str;
        default = "id";
      };
      docOrigin = lib.mkOption {
        type = lib.types.str;
        default = "id";
      };
      caddyConfig = lib.mkOption {
        type = lib.types.str;
        default = ''
          tls internal
          reverse_proxy localhost:3000 {
            header_up Host {host}
          }
        '';
      };
    };
    data = {
      origin = lib.mkOption {
        type = lib.types.str;
        default = "data";
      };
      caddyConfig = lib.mkOption {
        type = lib.types.str;
        default = ''
          tls internal
          reverse_proxy localhost:4700 {
            header_up Host {host}
            header_up X-Forwarded-Proto https
          }
        '';
      };
    };
  };

  config = {
    services.caddy = {
      enable = true;
      package = pkgs.caddy.withPlugins {
        plugins = [ "github.com/caddy-dns/gandi@v1.1.0" ];
        hash = "sha256-5mjD0CY7f5+sRtV1rXysj8PvId2gQaWiXlIaTg2Lv8A";
      };
      globalConfig = ''
        skip_install_trust
      '';
      virtualHosts = {
        "*.${cfg.id.idOrigin}".extraConfig = cfg.id.caddyConfig;
        ${cfg.id.docOrigin}.extraConfig = cfg.id.caddyConfig;
        "*.${cfg.data.origin}".extraConfig = cfg.data.caddyConfig;
        ${cfg.data.origin}.extraConfig = cfg.data.caddyConfig;
      };
    };

    networking.firewall.allowedTCPPorts = [ 80 443 ];
  };
}
