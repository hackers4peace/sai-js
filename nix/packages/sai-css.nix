{ pkgs }:

let
  runtime = pkgs.callPackage ./sai-runtime.nix { };
  version = (builtins.fromJSON (builtins.readFile ../../services/css/package.json)).version;
in
pkgs.runCommand "sai-css-${version}" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  passthru.version = version;
  meta = with pkgs.lib; {
    description = "serves SAI-CSS services";
    license = licenses.mit;
  };
} ''
  mkdir -p $out
  cp -r ${runtime}/app $out/app

  makeWrapper ${pkgs.nodejs_26}/bin/node $out/bin/sai-css \
    --add-flags "$out/app/node_modules/@solid/community-server/bin/server.js" \
    --chdir "$out/app"
''
