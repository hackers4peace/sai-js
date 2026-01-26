{
  description = "A sample NixOS-on-Lima configuration flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixos-lima = {
      url = "github:nixos-lima/nixos-lima/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixos-lima, home-manager, ... }@inputs:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      nixosConfigurations.h4p = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/lima.nix
          ./nix/caddy.nix
          ./nix/podman.nix
          {
        services.sai.containers = {
            id.idOrigin = "hackers4peace.net";
            id.docOrigin = "id.hackers4peace.net";
            id.sparqlEndpoint = "http://sparql/sparql";
            sparql.resolver = "127.0.0.11";
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
              id.idOrigin = "id";
              id.docOrigin = "id";
              id.sparqlEndpoint = "http://sparql/sparql";
              sparql.resolver = "127.0.0.11";
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
              id.idOrigin = "id";
              id.docOrigin = "id";
              id.sparqlEndpoint = "http://sparql/sparql";
              sparql.resolver = "127.0.0.11";
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
