{
  pkgs,
  config,
  ...
}:
let
  sai-ui = pkgs.callPackage ./packages/sai-ui.nix {};
  uiConfig = {
    backendBaseUrl = "https://auth.hackers4peace.net";
    vapidPublicKey = "BJ5cuKc1taNAQ87rXz9mO9g8kE7198r_yc2iCSexaqDlax4nUpnj9T1sxAyBH8l--1qiZCeSwCsDi6KYUkx2vBA";
    languages = ["en" "pl"];
    idOrigin = "hackers4peace.net";
    dataOrigin = "data.hackers4peace.net";
  };
  jsonFormat = pkgs.formats.json {};
  configFile = jsonFormat.generate "config.json" uiConfig;

  sai-ui-h4p = pkgs.runCommand "sai-ui-configured" {} ''
    mkdir -p $out
    cp -r ${sai-ui}/* $out/
    chmod +w $out
    cp ${configFile} $out/config.json
  '';
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

  age.secrets.fuseki = {
    file = ./secrets/fuseki.age;
    owner = "root";
    group = "root";
    mode = "0400";
  };

  age.secrets.garage = {
    file = ./secrets/garage.age;
    owner = "root";
    group = "root";
    mode = "0400";
  };

  services.sai.containers = {
    auth.env = config.age.secrets.auth.path;
    fuseki.env = config.age.secrets.fuseki.path;
    garage.env = config.age.secrets.garage.path;
    ui.caddyConfig = ''
      tls {
        dns gandi {env.GANDI_BEARER_TOKEN}
        propagation_delay 300s
      }
      root * ${sai-ui-h4p}
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

  services.caddy = {
    package = pkgs.caddy.withPlugins {
      plugins = [ "github.com/caddy-dns/gandi@v1.1.0" ];
      hash = "sha256-e2pxVxVoyrjk3F05lv3ZODSG+wegl6kY4TbqvV8n5vM=";
    };
  };

  networking.firewall = {
    enable = true;
    trustedInterfaces = [ "podman0" ];
    interfaces.enp1s0.allowedTCPPorts = [ 22 80 443 ]; # SSH HTTP HTTPS
    logRefusedConnections = false; # avoid log spam
    checkReversePath = "loose";    # avoids Hetzner asymmetric routing issues

    # Drop forwarded traffic from public NIC to podman
    extraCommands = ''
      iptables -A FORWARD -i enp1s0 -o podman0 -j DROP
    '';
  };
}
