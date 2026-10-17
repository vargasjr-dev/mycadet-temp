# iOS signing secrets — GCP SM → GitHub Actions

Converges the iOS signing secrets that
`.github/workflows/release-ios.yaml` consumes from their source of truth in
GCP Secret Manager into repo Actions secrets, per the portfolio doctrine in
`vargasjr.dev/terraform` (*SM is the source of truth; everything else is a
replica terraform converges*).

## Managed secrets (11)

| GHA secret (= SM secret ID) | What it is |
| --- | --- |
| `DIST_CERTIFICATE_P12` | Apple Distribution cert exported **with its private key** as `.p12` |
| `DIST_CERTIFICATE_PASSWORD` | Password set during that `.p12` export |
| `APPLE_TEAM_ID` | 10-char Team ID (developer.apple.com → Membership details) |
| `IOS_PROVISIONING_PROFILE` / `_DEV` | Main app (production / dev) |
| `IOS_PROVISIONING_PROFILE_NSE` / `_DEV` | Notification Service Extension |
| `IOS_PROVISIONING_PROFILE_SHARE` / `_DEV` | Share Extension |
| `IOS_PROVISIONING_PROFILE_EXT` / `_DEV` | Extension target |

**Staging secrets are deliberately excluded** (per Vargas) — extend the
`local.ios_secrets` map with the `_STAGING` IDs when wanted.

## Prerequisites

1. Each secret above exists in Secret Manager (project defaults to
   `mycadet`, override with `-var gcp_project=...`). Same name in the vault
   as the Actions secret.
2. Binary secrets (profiles, `.p12`) stored as the base64 text from
   `base64 -i <file>` (the README flow). If instead you uploaded raw file
   bytes to SM, apply with `-var binary_secrets_stored_base64=false` and
   terraform encodes them on the way in.
3. Credentials at apply time:
   - GCP: `gcloud auth application-default login` (or `GOOGLE_CREDENTIALS`)
   - GitHub: `GITHUB_TOKEN` with repo-secrets write access.

## Apply

```sh
terraform init
terraform plan
terraform apply
```

State lives in `gs://vargasjr-dev-tfstate/mycadet-temp/prod`.

## Rotation

Write a new version of the secret in Secret Manager, then
`terraform apply` — nothing else to touch.

## CI apply (future)

First apply is local (portfolio precedent). To move applies into this
repo's Actions, add `vargasjr-dev/mycadet-temp` to the portfolio list in
`vargasjr.dev/terraform/wif.tf` and wire a workflow that impersonates its
`terraform-apply` SA via WIF.
