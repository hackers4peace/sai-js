{ pkgs }:

let
  version = (builtins.fromJSON (builtins.readFile ../../services/id/package.json)).version;
in
pkgs.buildNpmPackage {
  pname = "sai-id";
  inherit version;

  src = pkgs.nix-gitignore.gitignoreSource [ ] ../../services/id;

  nodejs = pkgs.nodejs_26;

  npmDepsHash = "sha256-KvsOsjbHuruxtWl6o8ZzRX99uqGJs1wRzUE+50VB1WY=";

  dontNpmBuild = true;

  nativeBuildInputs = [ pkgs.makeWrapper ];

  installPhase = ''
    mkdir -p $out/app
    cp -r node_modules *.ts package.json $out/app/

    # The interop packages are published as TypeScript source, and Node 26
    # refuses to strip .ts files inside node_modules. Keep the workspace source
    # outside node_modules so Node can load (and strip) it.
    mkdir -p $out/app/packages
    cp -r ${../../packages/utils} $out/app/packages/interop-utils
    rm -rf $out/app/node_modules/@janeirodigital/interop-utils
    ln -s ../../packages/interop-utils $out/app/node_modules/@janeirodigital/interop-utils

    makeWrapper ${pkgs.nodejs_26}/bin/node $out/bin/sai-id \
      --add-flags "http.ts" \
      --chdir "$out/app"
  '';

  meta = with pkgs.lib; {
    description = "serves WebID, soon CID";
    license = licenses.mit;
  };
}
