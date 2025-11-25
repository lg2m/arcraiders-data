{
  description = "Bun/Typescript development environment";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            nodejs_latest

            # LSPs
            nodePackages_latest.typescript-language-server
            nodePackages_latest.vscode-langservers-extracted
            tailwindcss-language-server
            superhtml

            # Formatters & Linters
            biome
            prettierd

            # Misc
            nodePackages_latest.typescript
          ];

          shellHook = ''
            echo "Bun/Typescript dev environment loaded!";
            echo "Bun version: $(bun --version)"
            echo "Node.js version: $(node --version)"
            echo "Typescript version: $(tsc --version)"
            echo ""
            echo "Available tooling:"
            echo "  - typescript-language-server (LSP)"
            echo "  - vscode-langservers-extracted (LSP)"
            echo "  - tailwindcss-language-server (LSP)"
            echo "  - superhtml (LSP)"
            echo "  - biome (formatter)"
            echo "  - prettierd (formatter)"
          '';
        };
      }
    );
}
