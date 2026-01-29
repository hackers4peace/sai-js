{ pkgs, ... }:

pkgs.buildNpmPackage {
  pname = "sai-css";
  version = "0.1.0";

  src = pkgs.lib.cleanSource ../../services/css;

  npmDepsHash = "sha256-AF43iRsuWdl/ohvHiyHHU9TJ3fW56lW2MLthLK5wIpk=";

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
