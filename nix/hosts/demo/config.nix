let
  tag = "0b2f5613fe4632537c8e3597ea44ec01775d5496";
  vapidPublicKey = "BEuveySWp1pRLWZ-Jn9j_46lAY69hmonzX8RS9O84TPzRT65pUDr3k4YA5Xyr6Zqw86o-bsDihoUWJWw8_yswG4";
  domain = "fed.quest";
  tls = ''
    tls {
      dns cloudflare {env.CF_API_TOKEN}
    }
  '';
in {
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
  };
}
