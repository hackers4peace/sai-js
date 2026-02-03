{ pkgs, ... }:

pkgs.buildNpmPackage {
  pname = "sai-css";
  version = "0.1.2";

  src = pkgs.lib.cleanSource ../../services/css;

  npmDepsHash = "sha256-v+oUSyo5LYhG2cO8ul7ZK4ugJowfj13YddPP78v9cOs=";

  dontNpmBuild = true;

  nativeBuildInputs = [ pkgs.makeWrapper ];

  installPhase = ''
    mkdir -p $out/app
    cp -r node_modules *.ts package.json $out/app/

    makeWrapper ${pkgs.nodejs}/bin/node $out/bin/sai-css \
      --add-flags "$out/app/node_modules/@solid/community-server/bin/server.js" \
      --chdir "$out/app"
  '';

  meta = with pkgs.lib; {
    description = "serves SAI-CSS services";
    license = licenses.mit;
  };
}
