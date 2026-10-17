# Portfolio convention: state lives in GCS next to the rest of the fleet
# (see vargasjr.dev/terraform/backend.tf). This root is namespaced under
# the repo name.
terraform {
  required_version = ">= 1.5"

  backend "gcs" {
    bucket = "vargasjr-dev-tfstate"
    prefix = "mycadet-temp/prod"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }

    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}
