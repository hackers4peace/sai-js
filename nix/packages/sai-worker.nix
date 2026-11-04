{ pkgs }:

let
  runtime = pkgs.callPackage ./sai-runtime.nix { };
  version = (builtins.fromJSON (builtins.readFile ../../services/worker/package.json)).version;
in
pkgs.runCommand "sai-worker-${version}" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  passthru.version = version;
  meta = with pkgs.lib; {
    description = "serves SAI-Worker services";
    license = licenses.mit;
  };
} ''
  mkdir -p $out
  cp -r ${runtime}/app $out/app

  makeWrapper ${pkgs.nodejs_26}/bin/node $out/bin/sai-worker \
    --add-flags "$out/app/node_modules/@elfpavlik/sai-components/dist/workers/main.js" \
    --chdir "$out/app"
''
