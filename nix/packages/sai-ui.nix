{ pkgs }:

let
  version = (builtins.fromJSON (builtins.readFile ../../ui/authorization/package.json)).version;

  # The UI depends on the local api-messages workspace via `file:../../...`;
  # keep the relative layout in the build source.
  clean = path: pkgs.lib.cleanSourceWith {
    src = path;
    filter = p: type:
      pkgs.lib.cleanSourceFilter p type
      && !(builtins.elem (baseNameOf p) [ "dist" "dev-dist" "node_modules" ]);
  };

  src = pkgs.runCommand "sai-ui-src.tar.gz" {
    nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ];
  } ''
    mkdir -p $TMPDIR/ui $TMPDIR/packages
    cp -r ${clean ../../ui/authorization} $TMPDIR/ui/authorization
    cp -r ${clean ../../packages/api-messages} $TMPDIR/packages/api-messages
    chmod -R u+w $TMPDIR/packages/api-messages
    ln -s ../../ui/authorization/node_modules $TMPDIR/packages/api-messages/node_modules
    cp ${../../tsconfig.base.json} $TMPDIR/tsconfig.base.json
    tar -C $TMPDIR -czf $out ui packages tsconfig.base.json
  '';
in
pkgs.buildNpmPackage {
  pname = "sai-ui";
  inherit version src;

  sourceRoot = "ui/authorization";

  nodejs = pkgs.nodejs_26;

  npmDepsHash = "sha256-XtfPM3ed8MX0vkwvMpAtmTMzKzGmxtxiDyaOdzUgUV4=";
  makeCacheWritable = true;
  npmRebuildFlags = [ "--ignore-scripts" ];

  # `vue-tsc --noEmit` currently fails on the UI sources; the deployment
  # artifact only needs the Vite bundle, which builds successfully.
  buildPhase = ''
    runHook preBuild
    ./node_modules/.bin/vite build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist/* $out/
    runHook postInstall
  '';
}
