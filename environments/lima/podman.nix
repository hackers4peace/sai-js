{
  virtualisation.podman.enable = true;
  virtualisation.podman.dockerCompat = true;
  virtualisation.podman.defaultNetwork.settings.dns_enabled = true;

  virtualisation.oci-containers = {
    backend = "podman";
    containers = {
      nginx = {
        image = "nginx:alpine";
        ports = ["80:80"];
        cmd = ["sh" "-c" "echo 'Hello World' > /usr/share/nginx/html/index.html && exec nginx -g 'daemon off;'"];
      };
      caddy = {
        image = "caddy:latest";
        ports = ["443:443"];
        volumes = [
          "/home/elf-pavlik/code/solid/sai-js/environments/lima/Caddyfile:/etc/caddy/Caddyfile"
        ];
        cmd = ["caddy" "run" "--config" "/etc/caddy/Caddyfile"];
      };
    };
  };
}
