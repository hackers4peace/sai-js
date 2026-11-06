let
  demo = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJJ4OjexI3eBRGftybywXGxL8erIU5KiwfGoZBEKu/Pe";
in
{
  "secrets/cloudflare.age".publicKeys = [ demo ];
  "secrets/auth.age".publicKeys = [ demo ];
  "secrets/fuseki.age".publicKeys = [ demo ];
  "secrets/garage.age".publicKeys = [ demo ];
}
