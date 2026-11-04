{ config, pkgs, lib, ... }:
{
  imports = [ ../../podman.nix ];

  systemd.services.load-sai-id = {
    description = "Load sai-id image into Podman";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    before = [ "podman-id.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.podman}/bin/podman load -i ${pkgs.callPackage ../../images/sai-id.nix { }}";
      RemainAfterExit = true;
    };
  };

  systemd.services.load-sai-css = {
    description = "Load sai-css image into Podman";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "podman-postgresql.service" ];
    wants = [ "network-online.target" ];
    before = [ "podman-auth.service" "podman-registry.service" "podman-data.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.podman}/bin/podman load -i ${pkgs.callPackage ../../images/sai-css.nix { }}";
      RemainAfterExit = true;
    };
  };

  systemd.services.load-sai-worker = {
    description = "Load sai-worker image into Podman";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "podman-postgresql.service" "podman-temporal.service" ];
    wants = [ "network-online.target" ];
    before = [ "podman-worker.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.podman}/bin/podman load -i ${pkgs.callPackage ../../images/sai-worker.nix { }}";
      RemainAfterExit = true;
    };
  };
}
