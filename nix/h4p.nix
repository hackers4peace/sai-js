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
}
