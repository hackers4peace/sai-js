{
  pkgs,
  ...
}:
let
entrypoint = pkgs.writeText "docker-entrypoint-custom.sh" ''
  #!/bin/sh
  set -e

  envsubst '\$NGINX_RESOLVER' < /etc/nginx/nginx.conf > /etc/nginx/nginx.conf.tmp
  mv /etc/nginx/nginx.conf.tmp /etc/nginx/nginx.conf

  exec /docker-entrypoint.sh "$@"
'';

nginxConfig = pkgs.writeText "nginx.conf" ''
  user root;
  worker_processes 1;

  events { worker_connections 1024; }

  http {
      resolver ''${NGINX_RESOLVER} valid=30s ipv6=off;

      map $http_content_type $sparql_backend {
          default http://oxigraph:7878/query;
          "application/sparql-query" http://oxigraph:7878/query;
          "application/sparql-update" http://oxigraph:7878/update;
          "application/trig" http://oxigraph:7878/store;
      }

      server {
          listen 80;

          location /sparql {
              proxy_pass $sparql_backend;
              proxy_set_header Host $host;
              proxy_set_header X-Real-IP $remote_addr;
              proxy_next_upstream error timeout invalid_header http_500 http_502 http_503;
          }

          location / {
              proxy_pass http://oxigraph:7878/;
              proxy_set_header Host $host;
              proxy_set_header X-Real-IP $remote_addr;
          }

          location /health {
              access_log off;
              add_header Content-Type text/plain;
              return 200 'healthy';
          }
      }
  }
'';
  nginxBase =
    if pkgs.system == "x86_64-linux" then {
      sha256 = "sha256-/OjrhHIQuhEZYQ5HtzQ2GqJPg8n0GMtCIgE3JWnO3Do=";
    } else if pkgs.system == "aarch64-linux" then {
      sha256 = "sha256-ntykiupgLPEcXxiZO2GGjKNtNYzj+V2qEdGiVuceV7M=";
    } else
      throw "Unsupported system: ${pkgs.system}";
in
pkgs.dockerTools.buildImage {
  name = "quay.io/hackers4peace/sai-oxigraph";
  tag = "latest";

  fromImage = pkgs.dockerTools.pullImage {
    imageName = "docker.io/library/nginx";
    finalImageName = "docker.io/library/nginx";
    finalImageTag = "alpine";

    imageDigest = "sha256:b0f7830b6bfaa1258f45d94c240ab668ced1b3651c8a222aefe6683447c7bf55";
    sha256 = nginxBase.sha256;
  };

  config = {
    Cmd = [ "nginx" "-g" "daemon off;" ];
    Entrypoint = [ "/docker-entrypoint-custom.sh" ];
  };

  extraCommands = ''
    mkdir -p etc/nginx
    cp ${nginxConfig} etc/nginx/nginx.conf
    cp ${entrypoint} docker-entrypoint-custom.sh
    chmod +x docker-entrypoint-custom.sh
  '';
}
