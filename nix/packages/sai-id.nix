{ pkgs, ... }:

pkgs.buildNpmPackage {
  pname = "sai-id";
  version = "0.3.1";

  src = pkgs.lib.cleanSource ../../services/id;

  npmDepsHash = "sha256-5GPdkah7ATlmqtrwtIQN6bkpKK9raJYbx+hOFb3KGrg=";

  dontNpmBuild = true;

  nativeBuildInputs = [ pkgs.makeWrapper ];

  installPhase = ''
    mkdir -p $out/app
    cp -r node_modules *.ts package.json $out/app/

    makeWrapper ${pkgs.nodejs}/bin/node $out/bin/sai-id \
      --add-flags "http.ts" \
      --chdir "$out/app"
  '';

  meta = with pkgs.lib; {
    description = "serves WebID, soon CID";
    license = licenses.mit;
  };
}
