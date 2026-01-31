{ pkgs }:

pkgs.buildNpmPackage {
  pname = "sai-ui";
  version = "0.1.0";

  src = pkgs.lib.cleanSource ../../ui/authorization;

  npmDepsHash = "sha256-acb2tJb3b/QOAKYREi+kVN4ELEocQJ+b1t6fUm1S36Y";

  npmBuildScript = "build";

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist/* $out/
    runHook postInstall
  '';
}
