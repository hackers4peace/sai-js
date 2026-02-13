{ pkgs }:

pkgs.buildNpmPackage {
  pname = "sai-ui";
  version = "0.1.1";

  src = pkgs.lib.cleanSource ../../ui/authorization;

  npmDepsHash = "sha256-piCukmOTNt90XZK7/ksunzQG8x7YTwu0Y/PlHoSyK3w=";
  makeCacheWritable = true;

  npmBuildScript = "build";

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist/* $out/
    runHook postInstall
  '';
}
