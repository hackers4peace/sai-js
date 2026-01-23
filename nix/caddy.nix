{ config, pkgs, lib, ... }:
let
  cfg = config.services.sai.containers;
  extraConfig = ''
    tls internal
    reverse_proxy localhost:3000 {
      header_up Host {host}
    }
  '';
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
    };
  };

  config = {
    services.caddy = {
      enable = true;
      globalConfig = ''
        skip_install_trust
      '';
      virtualHosts = {
        "*.${cfg.id.idOrigin}".extraConfig = extraConfig;
        ${cfg.id.docOrigin}.extraConfig = extraConfig;
      };
    };

    networking.firewall.allowedTCPPorts = [ 80 443 ];
  };
}
