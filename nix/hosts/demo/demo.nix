{
  pkgs,
  config,
  ...
}:
let
  # Quay image tags are the commit SHA of the release.
  tag = "4db779a50ecc820892d6dc3c040d440c312bd246";
  vapidPublicKey = "BDtZZfJveRXEVyBuOMHXldpziUh5SPuOew1msARfr3WQvMAcY4Mh9oadl8-plOXJExIMtl07VzpBuoOoNSRfvmo";
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

  systemd.services.caddy.serviceConfig.EnvironmentFile = [
    config.age.secrets.cloudflare.path
  ];

  services.caddy = {
    package = pkgs.caddy.withPlugins {
      plugins = [ "github.com/caddy-dns/cloudflare@v0.2.4" ];
      hash = "sha256-tubXIDCJnO2mvdnPlZclwDhNGaeeYLSt7lnni3+pXDo=";
    };
  };

  services.sai.containers = {
    id.idOrigin = domain;
    id.docOrigin = "id.${domain}";
    data.origin = "data.${domain}";
    registry.origin = "reg.${domain}";
    auth.origin = "auth.${domain}";
    ui.origin = "app.auth.${domain}";
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
    fuseki.env = config.age.secrets.fuseki.path;
    garage.env = config.age.secrets.garage.path;
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
    allowedTCPPorts = [
      22
      80
      443
    ];
    logRefusedConnections = false;
    checkReversePath = "loose";
    extraCommands = ''
      iptables -A FORWARD -i eth0 -o podman0 -j DROP
    '';
  };
}
