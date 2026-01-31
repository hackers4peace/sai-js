{ config, pkgs, lib, ... }:
let
  cfg = config.services.sai.containers;
  sai-ui = pkgs.callPackage ./packages/sai-ui.nix {};
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
    auth = {
      origin = lib.mkOption {
        type = lib.types.str;
        default = "auth";
      };
      caddyConfig = lib.mkOption {
        type = lib.types.str;
        default = ''
          tls internal
          reverse_proxy localhost:4800 {
            header_up Host {host}
            header_up X-Forwarded-Proto https
          }
        '';
      };
    };
    ui = {
      origin = lib.mkOption {
        type = lib.types.str;
        default = "app.auth";
      };
      caddyConfig = lib.mkOption {
        type = lib.types.str;
        default = ''
          tls internal
          root * ${sai-ui}
          encode zstd gzip
          # history fallback
          try_files {path} {path}/ /index.html
          file_server
        '';
      };
    };
    registry = {
      origin = lib.mkOption {
        type = lib.types.str;
        default = "registry";
      };
      caddyConfig = lib.mkOption {
        type = lib.types.str;
        default = ''
          tls internal
          reverse_proxy localhost:4600 {
            header_up Host {host}
            header_up X-Forwarded-Proto https
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
    environment.systemPackages = [
      sai-ui
    ];

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
        ${cfg.registry.origin}.extraConfig = cfg.registry.caddyConfig;
        ${cfg.auth.origin}.extraConfig = cfg.auth.caddyConfig;
        ${cfg.ui.origin}.extraConfig = cfg.ui.caddyConfig;
      };
    };
  };
}
