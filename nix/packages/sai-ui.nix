{ pkgs }:

pkgs.buildNpmPackage {
  pname = "sai-ui";
  version = "0.1.1";

  src = pkgs.lib.cleanSource ../../ui/authorization;

  npmDepsHash = "sha256-nz4OojILhqzaa8Cxf3tGlvvm+h+eMDo++Dtm75CKyeo";
  makeCacheWritable = true;

  npmBuildScript = "build";

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist/* $out/
    runHook postInstall
  '';
}
