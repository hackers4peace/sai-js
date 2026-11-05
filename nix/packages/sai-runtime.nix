{ pkgs }:

let
  version = (builtins.fromJSON (builtins.readFile ../../services/css/package.json)).version;

  # Build the repo workspace so the CSS/worker images run the current
  # `packages/components` source, not the published npm package. Keep the
  # source narrow so UI/host/nix edits do not invalidate the npm cache and
  # the ~800 MB runtime output.
  root = ../..;
  src = pkgs.lib.cleanSourceWith {
    src = root;
    filter = path: type:
      let
        rel = pkgs.lib.removePrefix (toString root + "/") (toString path);
        top = builtins.head (pkgs.lib.splitString "/" rel);
      in
      pkgs.lib.cleanSourceFilter path type
      && (
        toString path == toString root
        || builtins.elem rel [ "package.json" "package-lock.json" "tsconfig.base.json" "turbo.json" "test/package.json" "docs/website/package.json" ]
        || (
          top == "packages"
          && !(pkgs.lib.hasInfix "/node_modules" ("/" + rel))
          && !(pkgs.lib.hasInfix "/dist" ("/" + rel))
          && !(pkgs.lib.hasInfix "/.turbo" ("/" + rel))
          && !(pkgs.lib.hasSuffix ".tsbuildinfo" rel)
        )
      );
  };

in
pkgs.buildNpmPackage {
  pname = "sai-runtime";
  inherit version src;

  nodejs = pkgs.nodejs_26;

  npmDepsHash = "sha256-ndTH96ZoHG03GxAV+gVBMA1pZoj/g+g12blWlzaiEvo=";
  makeCacheWritable = true;

  npmWorkspace = "packages/components";
  npmBuildScript = "build";

  # We only need the workspace tree + node_modules at runtime; the default
  # npm-install hook would try to package a single npm tarball.
  dontNpmInstall = true;

  installPhase = ''
    runHook preInstall

    # `npm ci --ignore-scripts` skips the git dependency's `prepare` build, so
    # overlay the prebuilt dist for the pinned fork commit (20af2b8) declared in
    # the root package.json overrides.
    rm -rf node_modules/@solid/access-token-verifier/dist
    cp -r ${../vendor/access-token-verifier/dist} node_modules/@solid/access-token-verifier/dist

    # Keep the full workspace node_modules: npm prune --omit=dev currently
    # drops some production transitive packages (e.g. `process`) in this
    # workspace layout. Optimize this once the runtime is stable.
    mkdir -p $out/app
    cp -r node_modules $out/app/
    cp -r packages $out/app/

    # Keep the workspace symlink valid after pruning/copying.
    rm -rf $out/app/node_modules/@elfpavlik/sai-components
    mkdir -p $out/app/node_modules/@elfpavlik
    ln -s ../../packages/components $out/app/node_modules/@elfpavlik/sai-components

    # Workspaces that are not needed at runtime; their symlinks would dangle.
    rm -f $out/app/node_modules/sai-test
    rm -f $out/app/node_modules/@janeirodigital/sai-js-docs-website

    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "SAI CSS/worker runtime built from the repo workspace";
    license = licenses.mit;
  };
}
