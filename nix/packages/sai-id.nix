{
  pkgs,
  ...
}:
pkgs.buildNpmPackage {
  pname = "sai-id";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    filter = name: type:
      let baseName = builtins.baseNameOf (builtins.toString name); in
      ! (pkgs.lib.hasPrefix ".devbox" baseName ||
         pkgs.lib.hasPrefix "node_modules" baseName ||
         pkgs.lib.hasPrefix ".git" baseName ||
         baseName == "flake.lock" ||
         baseName == "result");
    src = ../../services/id;
  };
  npmDepsHash = "sha256-5GPdkah7ATlmqtrwtIQN6bkpKK9raJYbx+hOFb3KGrg=";

  buildPhase = ''
    runHook preBuild
    runHook postBuild
  '';

  nativeBuildInputs = [ pkgs.makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/share/sai-id
    cp -r node_modules $out/share/sai-id/
    cp ./*.ts $out/share/sai-id/
    cp package.json $out/share/sai-id/

    makeWrapper ${pkgs.nodejs}/bin/node $out/bin/sai-id \
      --add-flags "http.ts" \
      --chdir "$out/share/sai-id" 

    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "serves WebID, soon CID";
    license = licenses.mit;
  };
}
