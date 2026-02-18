{
  pkgs,
  config,
  ...
}:
let
  tag = "0b2f5613fe4632537c8e3597ea44ec01775d5496";
  vapidPublicKey = "BEuveySWp1pRLWZ-Jn9j_46lAY69hmonzX8RS9O84TPzRT65pUDr3k4YA5Xyr6Zqw86o-bsDihoUWJWw8_yswG4";
  domain = "fed.quest";
  tls = ''
    tls {
      dns cloudflare {env.CF_API_TOKEN}
    }
  '';

  sai-ui = pkgs.callPackage ../../packages/sai-ui.nix { };
  uiConfig = {
    backendBaseUrl = "https://auth.${domain}";
    vapidPublicKey = vapidPublicKey;
    languages = [
      "en"
      "pl"
    ];
    idOrigin = "${domain}";
    dataOrigin = "data.${domain}";
  };
  jsonFormat = pkgs.formats.json { };
  configFile = jsonFormat.generate "config.json" uiConfig;

  sai-ui-demo = pkgs.runCommand "sai-ui-configured" { } ''
    mkdir -p $out
    cp -r ${sai-ui}/* $out/
    chmod +w $out
    cp ${configFile} $out/config.json
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

  systemd.services.caddy.serviceConfig.EnvironmentFile = [
    config.age.secrets.cloudflare.path
  ];

  services.caddy = {
    package = pkgs.caddy.withPlugins {
      plugins = [ "github.com/caddy-dns/cloudflare@v0.2.3" ];
      hash = "sha256-bJO2RIa6hYsoVl3y2L86EM34Dfkm2tlcEsXn2+COgzo";
    };
  };

  services.sai.containers = {
    sparql.resolver = "127.0.0.11";
    id.idOrigin = domain;
    id.docOrigin = "id.${domain}";
    data.origin = "data.${domain}";
    registry.origin = "reg.${domain}";
    auth.origin = "auth.${domain}";
    ui.origin = "app.auth.${domain}";
    sparql.tag = tag;
    id.tag = tag;
    data.tag = tag;
    registry.tag = tag;
    auth.tag = tag;
    worker.tag = tag;
    id.caddyConfig = ''
      ${tls}
      reverse_proxy localhost:3000 {
        header_up Host {host}
      }
    '';
    data.caddyConfig = ''
      ${tls}
      reverse_proxy localhost:4700 {
        header_up Host {host}
        header_up X-Forwarded-Proto https
      }
    '';
    auth.caddyConfig = ''
      ${tls}
      reverse_proxy localhost:4800 {
        header_up Host {host}
        header_up X-Forwarded-Proto https
      }
    '';
    registry.caddyConfig = ''
      ${tls}
      reverse_proxy localhost:4600 {
        header_up Host {host}
        header_up X-Forwarded-Proto https
      }
    '';
    data.baseUrl = "https://data.${domain}/";
    auth.vapidPublicKey = vapidPublicKey;
    auth.baseUrl = "https://auth.${domain}/";
    auth.authEndpoint = "https://app.auth.${domain}/authorize";
    auth.idOrigin = "${domain}";
    auth.docOrigin = "id.${domain}";
    auth.dataOrigin = "data.${domain}";
    auth.regOrigin = "reg.${domain}";
    registry.baseUrl = "https://reg.${domain}/";
    auth.env = config.age.secrets.auth.path;
    auth.cookieDomain = ".auth.${domain}";
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

  networking.firewall = {
    enable = true;
    trustedInterfaces = [ "podman0" ];
    interfaces.enp1s0.allowedTCPPorts = [
      22
      80
      443
    ];
    logRefusedConnections = false;
    checkReversePath = "loose";
    extraCommands = ''
      iptables -A FORWARD -i enp1s0 -o podman0 -j DROP
    '';
  };
}
