{
  pkgs,
  config,
  ...
}:
let
  sai-ui = pkgs.callPackage ../../packages/sai-ui.nix {};
  uiConfig = {
    backendBaseUrl = "https://auth.fed.quest";
    vapidPublicKey = "BEuveySWp1pRLWZ-Jn9j_46lAY69hmonzX8RS9O84TPzRT65pUDr3k4YA5Xyr6Zqw86o-bsDihoUWJWw8_yswG4";
    languages = ["en" "pl"];
    idOrigin = "fed.quest";
    dataOrigin = "data.fed.quest";
  };
  jsonFormat = pkgs.formats.json {};
  configFile = jsonFormat.generate "config.json" uiConfig;

  sai-ui-demo = pkgs.runCommand "sai-ui-configured" {} ''
    mkdir -p $out
    cp -r ${sai-ui}/* $out/
    chmod +w $out
    cp ${configFile} $out/config.json
  '';
  tls = ''
    tls {
      dns cloudflare {env.CF_API_TOKEN}
    }
  '';
in
{
  age.secrets.cloudflare = {
    file = ./secrets/cloudflare.age;
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
      ${tls}
      root * ${sai-ui-demo}
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
    config.age.secrets.cloudflare.path
  ];

  services.caddy = {
    package = pkgs.caddy.withPlugins {
      plugins = [ "github.com/caddy-dns/cloudflare@v0.2.3" ];
      hash = "sha256-bJO2RIa6hYsoVl3y2L86EM34Dfkm2tlcEsXn2+COgzo";
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
