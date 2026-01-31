{
  pkgs,
  config,
  ...
}:
let
  sai-ui = pkgs.callPackage ./packages/sai-ui.nix {};
in
{
  age.secrets.gandi = {
    file = ./secrets/gandi.age;
    owner = "caddy";
    group = "caddy";
    mode = "0400";
  };

  age.secrets.auth = {
    file = ./secrets/auth.age;
    owner = "root";
    group = "root";
    mode = "0400";
  };

  services.sai.containers = {
    auth.env = config.age.secrets.auth.path;
    ui.caddyConfig = ''
      tls {
        dns gandi {env.GANDI_BEARER_TOKEN}
        propagation_delay 300s
      }
      root * ${sai-ui}
      encode zstd gzip
      try_files {path} {path}/ /index.html
      file_server
      header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
      }
    '';
  };

  systemd.services.caddy.serviceConfig.EnvironmentFile = [
    config.age.secrets.gandi.path
  ];

  networking.firewall = {
    enable = true;

    interfaces.enp1s0.allowedTCPPorts = [ 22 80 443 ]; # SSH HTTP HTTPS
    logRefusedConnections = false; # avoid log spam
    checkReversePath = "loose";    # avoids Hetzner asymmetric routing issues

    # Drop forwarded traffic from public NIC to podman
    extraCommands = ''
      iptables -A FORWARD -i enp1s0 -o podman0 -j DROP
    '';
  };
}
