# Local + Cloudflare sync

## Recommended arrangement

Use the Cloudflare Pages + D1 version as the master database. Use the local version for testing, offline preparation, or safe experiments. The two D1 databases are separate; installing the same code in two places does not automatically synchronize their data.

## First-time setup

1. Start the local version using `README.md`.
2. Deploy the Cloudflare version using `README.md`.
3. Open the online CRM and restore `crm-backup.json` once.
4. From then on, do normal CRM work in the online version.

## Pull cloud data into local

Use this when you want your local copy to match the online CRM:

1. Open the online CRM.
2. Go to **Backup & settings → Download backup (JSON)**.
3. Open the local CRM.
4. Go to **Backup & settings → Restore from backup**.
5. Select the downloaded JSON file and confirm.

This replaces the local database with the cloud backup.

## Push local data to cloud

Use this only when you intentionally want local changes to become the online master:

1. In the local CRM, download a JSON backup.
2. Keep that file as a safety copy.
3. Open the online CRM.
4. First download a backup of the online database too.
5. Restore the local JSON backup in the online CRM.

This replaces the online database. Do not do this if the online database contains newer work you need to keep.

## Safe rules

- Always download a backup from the receiving side before restoring.
- Do not edit local and online copies at the same time.
- A restore replaces data; it does not merge two independent databases.
- The current sync method preserves companies, contacts, messages, templates, sequences, tasks, tags, tracking events, settings and snippets in version 2 backups.
- If you only want to test something locally, do not push that local database back to Cloudflare.

## Optional automated sync

Automatic live two-way sync is not enabled in this build. It would require authentication between the local app and the deployed app plus conflict-resolution rules. Cloud-as-master plus explicit backup/restore is the safest setup for this CRM.
