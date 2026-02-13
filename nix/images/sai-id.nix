{ pkgs, ... }:

let
  sai-id = pkgs.callPackage ../packages/sai-id.nix {};
in

pkgs.dockerTools.buildImage {
  name = "quay.io/hackers4peace/sai-id";
  tag = sai-id.version;

  copyToRoot = pkgs.buildEnv {
    name = "root";
    paths = [
      pkgs.busybox
      pkgs.cacert
      pkgs.nodejs
      sai-id
    ];
    pathsToLink = [ "/bin" "/app" "/etc" ];
  };

  config = {
    Cmd = [ "/bin/node" "http.ts" ];
    WorkingDir = "/app";
  };
}
