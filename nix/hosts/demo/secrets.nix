let
  demo = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlY5y8MjRNNiKWwx9zByLgWcnS6BXh46eIwLFe4mdnR";
in
{
  "secrets/cloudflare.age".publicKeys = [ demo ];
  "secrets/auth.age".publicKeys = [ demo ];
}
