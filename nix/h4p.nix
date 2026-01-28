{
  config,
  ...
}:
{
  age.secrets.gandi = {
    file = ./secrets/gandi.age;
    owner = "caddy";
    group = "caddy";
    mode = "0400";
  };
  systemd.services.caddy.serviceConfig.EnvironmentFile =
    [ config.age.secrets.gandi.path ];

  networking.firewall = {
    enable = true;

    interfaces.enp1s0.allowedTCPPorts = [ 22 80 443 ]; # SSH HTTP HTTPS
    logRefusedConnections = false; # avoid log spam
    checkReversePath = "loose";    # avoids Hetzner asymmetric routing issues

    # Drop forwarded traffic from public NIC to podman
    extraCommands = ''
      iptables -A FORWARD -i enp1s0 -o podman0 -j DROP
    '';
  };
}
