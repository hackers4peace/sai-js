{ pkgs, ... }:
let
  sai-ui = pkgs.callPackage ../../packages/sai-ui.nix { };
  uiConfig = {
    backendBaseUrl = "https://auth.localhost";
    vapidPublicKey = "BNUaG9vwp-WE_cX-3dNLebyczW_RivE8wHECIvZIUMUZ3co6P79neE3hueJJtFcg5ezTZ25T1ITciujz-mlAcnY";
    languages = [
      "en"
      "pl"
    ];
    idOrigin = "id.localhost";
    dataOrigin = "data.localhost";
    otlpBaseUrl = "/otlp";
  };
  jsonFormat = pkgs.formats.json { };
  configFile = jsonFormat.generate "config.json" uiConfig;
  sai-ui-lima = pkgs.runCommand "sai-ui-lima" { } ''
    mkdir -p $out
    cp -r ${sai-ui}/* $out/
    chmod +w $out
    cp ${configFile} $out/config.json
  '';
in
{
  services.sai.containers = {
    fuseki.env = ../../../environments/dev/fuseki.env;
    garage.env = ../../../environments/dev/garage.env;

    id.idOrigin = "id.localhost";
    id.docOrigin = "id.localhost";

    data.origin = "data.localhost";
    data.baseUrl = "https://data.localhost/";

    registry.origin = "registry.localhost";
    registry.baseUrl = "https://registry.localhost/";

    auth.origin = "auth.localhost";
    auth.vapidPublicKey = "BNUaG9vwp-WE_cX-3dNLebyczW_RivE8wHECIvZIUMUZ3co6P79neE3hueJJtFcg5ezTZ25T1ITciujz-mlAcnY";
    auth.baseUrl = "https://auth.localhost/";
    auth.authEndpoint = "https://app.auth.localhost/authorize";
    auth.env = ../../../environments/dev/env;
    auth.idOrigin = "id.localhost";
    auth.docOrigin = "id.localhost";
    auth.dataOrigin = "data.localhost";
    auth.regOrigin = "registry.localhost";
    auth.cookieDomain = ".auth.localhost";

    ui.origin = "app.auth.localhost";
    ui.root = sai-ui-lima;
  };
}
