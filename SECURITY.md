# Security policy

## Reporting a vulnerability

Please report security issues **privately** by email to [mail@superport.digital](mailto:mail@superport.digital) with the subject
"Security: Screen Self-Service for Jira". Do not open a public GitHub issue.

Please include what you found, how to reproduce it, and the impact you expect. We confirm receipt within two business days and keep you
informed until it's resolved. We won't take legal action against good-faith research that respects users' privacy and doesn't disrupt
customer sites.

## Supported versions

Only the version currently live on the Atlassian Marketplace is supported. Forge apps update automatically for customers within the same
major version.

## How the app protects customers

See [docs/DATA_SECURITY_PRIVACY.md](docs/DATA_SECURITY_PRIVACY.md) and the [threat model](docs/THREAT_MODEL.md). In short: Runs on Atlassian
(no egress), every request re-checks the user's real Jira permissions, objects shared with other projects are never changed, and the app
fails closed.

## Incidents

Status and incident updates: https://superapps.statuspage.io/
