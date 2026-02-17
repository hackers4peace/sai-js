{
  services.sai.containers = {
    sparql.resolver = "127.0.0.11";
    id.idOrigin = "id";
    id.docOrigin = "id";
    data.baseUrl = "https://data/";
    auth.vapidPublicKey = "BNUaG9vwp-WE_cX-3dNLebyczW_RivE8wHECIvZIUMUZ3co6P79neE3hueJJtFcg5ezTZ25T1ITciujz-mlAcnY";
    auth.baseUrl = "https://auth/";
    auth.authEndpoint = "https://app.auth/authorize";
    auth.env = ../../../packages/css-storage-fixture/dev/env;
    auth.idOrigin = "id";
    auth.docOrigin = "id";
    auth.dataOrigin = "data";
    auth.cookieDomain = ".auth";
    auth.regOrigin = "registry";
    registry.baseUrl = "https://registry/";
  };
}
