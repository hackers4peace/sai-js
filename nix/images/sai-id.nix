{
  pkgs,
  ...
}:
let
  sai-id = pkgs.callPackage ../packages/sai-id.nix { };
in
pkgs.dockerTools.buildImage {
  name = "hackers4peace/sai-id";
  tag = "latest";

  config = {
    Cmd = [ "${pkgs.nodejs}/bin/node" "http.ts" ];
    Env = [
      "NODE_ENV=production"
      "DOMAIN=id"
      "CSS_SPARQL_ENDPOINT=http://sparql/sparql"
    ];
    WorkingDir = "/app";
  };

  copyToRoot = pkgs.buildEnv {
    name = "sai-id-root";
    paths = [ pkgs.nodejs ];
    pathsToLink = [ "/bin" ];
  };

  extraCommands = ''
    mkdir -p app
    cp -r ${sai-id}/share/sai-id/* app/
  '';
}
