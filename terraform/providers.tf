provider "google" {
  # The mycadet project's Secret Manager vault is the source of truth.
  # Authentication comes from Application Default Credentials at apply time
  # (`gcloud auth application-default login`) or GOOGLE_CREDENTIALS. No
  # credential is stored in this repository.
  project = var.gcp_project
}

provider "github" {
  # Token with repo-secrets write access, supplied via the GITHUB_TOKEN
  # environment variable at apply time — never committed.
  owner = "vargasjr-dev"
}
