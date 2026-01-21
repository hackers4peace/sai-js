{ config, pkgs, lib, ... }:
let
  cfg = config.services.sai.containers;
in
{
  options.services.sai.containers = {
    id = {
      domain = lib.mkOption {
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
      virtualHosts.${cfg.id.domain}.extraConfig = ''
        tls internal
        reverse_proxy localhost:3000 {
          header_up Host ${cfg.id.domain}
        }
      '';
    };

    networking.firewall.allowedTCPPorts = [ 80 443 ];
  };
}
