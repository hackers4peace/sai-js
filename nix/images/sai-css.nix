
{ pkgs, ... }:

let
  sai-css = pkgs.callPackage ../packages/sai-css.nix {};
in

pkgs.dockerTools.buildImage {
  name = "hackers4peace/sai-css";
  tag = sai-css.version;

  copyToRoot = pkgs.buildEnv {
    name = "root";
    paths = [
      pkgs.nodejs
      sai-css
      (pkgs.runCommand "data-dirs" {} ''
        mkdir -p $out/data $out/config
        chmod 0775 $out/data $out/config
      '')
      ];
    pathsToLink = [ "/bin" "/app" ];
  };

  config = {
    Cmd = [ "/bin/sai-css" ];
    WorkingDir = "/app";
  };
}
