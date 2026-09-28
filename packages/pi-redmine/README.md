# pi-redmine

Native Redmine tools for Pi: `redmine_get_issue` and `redmine_search_issues`.
No Redmine instance is hardcoded — every deployment points at its own via env vars.

## Setup

```
cp config/redmine.env.example ~/.keys/redmine.env
# edit ~/.keys/redmine.env: set REDMINE_URL and REDMINE_API_KEY
```

`REDMINE_URL` / `REDMINE_API_KEY` in the process environment take priority over
`~/.keys/redmine.env` (see `src/config.ts`). Neither the URL nor the key is ever
committed to this repo.

## Tools

- `redmine_get_issue(issue_id, include_journals?, include_attachments?)` — fetch one
  ticket: subject, description, custom fields, comments, attachments.
- `redmine_search_issues(query, limit?)` — full-text search across issues.
