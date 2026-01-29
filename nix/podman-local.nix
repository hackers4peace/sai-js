{ config, pkgs, lib, ... }:
{
  imports = [ ./podman.nix ];

  systemd.services.load-sai-oxigraph = {
    description = "Load sai-oxigraph image into Podman";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    before = [ "podman-sparql.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.podman}/bin/podman load -i ${pkgs.callPackage ./images/sai-oxigraph.nix { }}";
      RemainAfterExit = true;
    };
  };

  systemd.services.load-sai-id = {
    description = "Load sai-id image into Podman";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    before = [ "podman-id.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.podman}/bin/podman load -i ${pkgs.callPackage ./images/sai-id.nix { }}";
      RemainAfterExit = true;
    };
  };

  systemd.services.load-sai-css = {
    description = "Load sai-css image into Podman";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "podman-postgresql.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.podman}/bin/podman load -i ${pkgs.callPackage ./images/sai-css.nix { }}";
      RemainAfterExit = true;
    };
  };
}
