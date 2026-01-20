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
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      nixosConfigurations.base = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/base.nix
        ];
      };
      nixosConfigurations.sai = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/base.nix
          ./nix/podman.nix
        ];
      };
      nixosConfigurations.sai-local = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/base.nix
          ./nix/podman-local.nix
        ];
      };

      packages.${system} = {
        sai-oxigraph = pkgs.callPackage ./nix/images/sai-oxigraph.nix { };
        sai-oxigraph-image = pkgs.callPackage ./nix/images/sai-oxigraph.nix { };
        sai-id = pkgs.callPackage ./nix/packages/sai-id.nix { };
        sai-id-image = pkgs.callPackage ./nix/images/sai-id.nix { };
      };
    };
}
