# ResuMatch Local Workbench Privacy Policy

Effective date: 2026-07-28

Replace `SUPPORT_EMAIL` with a monitored support address before publishing this policy.

## What this extension does

ResuMatch Local Workbench helps users organize job information they choose to view in supported recruitment pages and create message drafts for the user to review. It does not automatically submit applications or send messages.

## Data processed locally

When a user starts a feature, the extension may process job descriptions, company details, application status, resume-related content and chat messages visible in the user's browser session. The local workbench stores this information on the user's computer in a local SQLite database.

The extension uses a loopback service at `127.0.0.1`; it is not designed to expose this data to a local network or the public internet.

## No default remote transfer

By default, resume content, job descriptions and conversations are processed locally. Cloud AI is disabled by default and can only be used after a user explicitly enables it and configures an HTTPS endpoint. Users should review the privacy practices of any cloud AI endpoint they choose to enable.

Anonymous telemetry is disabled by default. It cannot send requests until both the user enables it and a valid HTTPS endpoint is configured. When enabled, it is limited to an anonymous random device identifier, fixed event names, numeric counts and fixed status values. It must not include URLs, names, account identifiers, resume text, job descriptions or chat content.

## Sharing and sale

ResuMatch does not sell user data. It does not use user data for advertising, creditworthiness, lending, insurance or other unrelated purposes. It does not share local workbench data with third parties by default.

## User controls

Users can stop using the extension, disable anonymous telemetry in the extension popup, and remove local data by uninstalling the local workbench or deleting its local database. Users control whether to enable any optional cloud AI integration.

## Contact

For privacy questions, contact: SUPPORT_EMAIL
