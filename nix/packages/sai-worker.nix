{ pkgs, ... }:

pkgs.buildNpmPackage {
  pname = "sai-worker";
  version = "0.1.0";

  src = pkgs.lib.cleanSource ../../services/worker;

  npmDepsHash = "sha256-Al25pFSsXkNMGh76aNcuDwu689i6hpVjui8b17X5kCY=";

  dontNpmBuild = true;

  nativeBuildInputs = [ pkgs.makeWrapper ];

  installPhase = ''
    mkdir -p $out/app
    cp -r node_modules package.json $out/app/

    makeWrapper ${pkgs.nodejs}/bin/node $out/bin/sai-worker \
      --add-flags "$out/app/node_modules/@elfpavlik/sai-components/dist/workers/main.js" \
      --chdir "$out/app"
  '';

  meta = with pkgs.lib; {
    description = "serves SAI-Worker services";
    license = licenses.mit;
  };
}
