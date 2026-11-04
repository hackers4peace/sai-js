{ pkgs }:

let
  version = (builtins.fromJSON (builtins.readFile ../../services/id/package.json)).version;
in
pkgs.buildNpmPackage {
  pname = "sai-id";
  inherit version;

  src = pkgs.nix-gitignore.gitignoreSource [ ] ../../services/id;

  nodejs = pkgs.nodejs_26;

  npmDepsHash = "sha256-jukN5OpuWNnfQAYnt6LarMh4UDcbfX82FprGogOvBEU=";

  dontNpmBuild = true;

  nativeBuildInputs = [ pkgs.makeWrapper ];

  installPhase = ''
    mkdir -p $out/app
    cp -r node_modules *.ts package.json $out/app/

    makeWrapper ${pkgs.nodejs_26}/bin/node $out/bin/sai-id \
      --add-flags "http.ts" \
      --chdir "$out/app"
  '';

  meta = with pkgs.lib; {
    description = "serves WebID, soon CID";
    license = licenses.mit;
  };
}
