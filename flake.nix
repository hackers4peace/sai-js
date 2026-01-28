{
  description = "A sample NixOS-on-Lima configuration flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    ragenix = {
      url = "github:yaxitech/ragenix";
      inputs.darwin.follows = "";
    };
    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";
    nixos-lima = {
      url = "github:nixos-lima/nixos-lima/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, ragenix, disko, nixos-lima, home-manager, ... }@inputs:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      nixosConfigurations.hetzner-cloud-aarch64 = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        modules = [
          disko.nixosModules.disko
          ./nix/base.nix
        ];
      };

      nixosConfigurations.h4p = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        modules = [
          disko.nixosModules.disko
          ragenix.nixosModules.default
          ./nix/base.nix
          ./nix/h4p.nix
          ./nix/caddy.nix
          ./nix/podman.nix
          {
            services.sai.containers = {
              sparql.resolver = "127.0.0.11";
              sparql.tag = "dc60ef729bc4293f86501e678a4699248c97ec3e";
              id.idOrigin = "hackers4peace.net";
              id.docOrigin = "id.hackers4peace.net";
              id.sparqlEndpoint = "http://sparql/sparql";
              id.tag = "dc60ef729bc4293f86501e678a4699248c97ec3e";
              id.caddyConfig = ''
                tls {
                  dns gandi {env.GANDI_BEARER_TOKEN}
                  propagation_delay 300s
                }
                reverse_proxy localhost:3000 {
                  header_up Host {host}
                }
              '';
            };
          }
        ];
      };
      nixosConfigurations.lima = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/lima.nix
          ./nix/caddy.nix
          ./nix/podman.nix
          {
            services.sai.containers = {
              sparql.resolver = "127.0.0.11";
              sparql.tag = "dc60ef729bc4293f86501e678a4699248c97ec3e";
              id.idOrigin = "id";
              id.docOrigin = "id";
              id.sparqlEndpoint = "http://sparql/sparql";
              id.tag = "dc60ef729bc4293f86501e678a4699248c97ec3e";
            };
          }
        ];
      };
      nixosConfigurations.lima-local = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/lima.nix
          ./nix/caddy.nix
          ./nix/podman-local.nix
          {
            services.sai.containers = {
              sparql.resolver = "127.0.0.11";
              id.idOrigin = "id";
              id.docOrigin = "id";
              id.sparqlEndpoint = "http://sparql/sparql";
            };
          }
        ];
      };

      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          sai-oxigraph = pkgs.callPackage ./nix/packages/sai-oxigraph.nix { };
          sai-oxigraph-image = pkgs.callPackage ./nix/images/sai-oxigraph.nix { };

          sai-id = pkgs.callPackage ./nix/packages/sai-id.nix { };
          sai-id-image = pkgs.callPackage ./nix/images/sai-id.nix { };
        }
      );
    };
}
