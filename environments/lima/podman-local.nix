{ config, pkgs, lib, ... }:
{
  imports = [ ./podman.nix ];

  systemd.services.load-sai-oxigraph = {
    description = "Load sai-oxigraph image into Podman";
    wantedBy = [ "multi-user.target" ];
    wants = [ "podman-sparql.service" ];
    after = [ "network-online.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.podman}/bin/podman load -i ${pkgs.callPackage ./images/sai-oxigraph.nix { }}";
      RemainAfterExit = true;
    };
  };
}
