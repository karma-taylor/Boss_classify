# ResuMatch Local Workbench Project Guide

## 1. Technology Stack And Version Constraints

- Runtime: Node.js `>=22 <25`; the project uses ESM (`"type": "module"`).
- HTTP service: Express 4.
- Database: Node built-in `node:sqlite` (`DatabaseSync`) with SQLite WAL mode,
  foreign keys, and a 5-second busy timeout.
- Browser integration: Chrome Manifest V3 extension and Playwright 1.45 for the
  legacy CDP diagnostic/read path. The normal collection path is the extension,
  not CDP.
- Frontend: static Vue application served from `public/index.html`.
- Tests: Node's built-in test runner. Run `npm test` before delivery.

Do not downgrade Node below 22. Do not introduce a native SQLite package unless
there is an explicit migration decision.

## 2. Key Modules And Calling Boundaries

### Local service

- `src/server.js`: Express entry point, API routing, import/evaluation orchestration.
- `src/db.js`: schema migration, transactional persistence, application status
  advancement, reply event persistence, and historical statistics.
- `src/candidate.js`: candidate filtering, recommendation classification, and
  daily recommendation capacity.
- `src/localWorker.js`, `src/workerClient.js`: local fallback and remote Worker
  integration for JD evaluation, greeting generation, and message intent analysis.
- `src/historySync.js`, `src/messageClassifier.js`, `src/intents.js`: per-message
  reply classification and event/state updates.
- `src/boss.js`: search task construction, city mapping, list-page filtering, and
  the legacy CDP read path.

### Chrome extension

- `browser-extension/content-script.js`: reads Boss DOM, communicates with the
  workbench page, collects list jobs and chat messages. It must never send a
  message or submit an application.
- `browser-extension/background.js`: opens collection tabs, runs list-page
  collection, enriches accepted jobs, imports to the local service, and manages
  extension-side task state.
- `browser-extension/popup.*`: concise extension controls only. Keep the full
  management experience in the workbench.

### Browser-to-service flow

1. Workbench emits a `window.postMessage` request.
2. Content script opens an extension Port.
3. Background script collects/imports through `http://127.0.0.1:8788`.
4. `POST /api/jobs/import` persists jobs and triggers evaluation.
5. The workbench reads candidates from `GET /api/candidates`.

Keep this flow explicit. Do not reintroduce a hidden automatic-apply path.

## 3. Data Rules That Must Not Drift

- `jobs.company_size` is authoritative only when
  `company_size_source = 'company_basic_info'`.
- List-card text and JD text must never be used to infer company size. They can
  contain unrelated headcounts such as experience or team size.
- The correct size source is the job preview's `"查看更多信息"` action followed by
  the detail page's `"公司基本信息"` card.
- If that detail page has no company basic-information card, record
  `company_kind = 'hunter'`; show `猎头岗位` in the candidate queue rather than a
  fabricated size.
- If loading or parsing fails, keep `company_kind = 'unknown'` and
  `company_size_source = 'unverified'`. Failure is not evidence of a hunter.
- Company size and preferred location are soft preferences. Salary, title, and
  keyword mismatch remain the list-stage filters. Experience years are not a
  hard filter.
- Applications only advance automatically: `queued/paused -> applied ->
  interested -> interview`. A manual status override is immutable to automated
  synchronization.
- Historical reply classification is per inbound HR message. `审核后确定` is
  process progress, not an interview. An interview requires an explicit action
  such as arranging a time, video call, or onsite interview.
- Do not create an application by fuzzy matching a contact name. Unmatched
  conversations belong in `unlinked_conversations` until a stable binding exists.

## 4. Code Conventions

- Keep source files UTF-8. For new Chinese strings in extension JavaScript, use
  Unicode escapes when they are near DOM matching logic to prevent encoding
  corruption during packaging or shell edits.
- Make small, localized changes. Do not reformat or rewrite unrelated modules.
- Use parameterized SQL and preserve the existing transaction boundaries.
- Do not silently swallow collection failures. Return structured reason codes
  such as `dom_mismatch`, `timeout_no_button`, `company_size_missing`, or
  `page_load_failed`.
- Every counter shown in UI must have a corresponding source counter in the API;
  do not report a successful collection after truncating or discarding data.
- Extend tests whenever a persistence, collection, or status-rule change is made.
- Avoid committing generated database files, debug profiles, logs, screenshots,
  `node_modules`, or secrets.

## 5. Repeated Failure Patterns And Required Fixes

### Incorrect company size

Cause: generic DOM scanning or fallback to a card's whole text matched numbers
that were not company headcount.

Required fix: set list extraction to unverified, enrich only after opening
`查看更多信息`, and parse only within the exact `公司基本信息` card. Persist the source
state so a page reload cannot revive a stale guessed value.

### Extension context invalidation

Cause: Chrome reloads an unpacked extension while an old content script remains
in a tab.

Required fix: content scripts must detect an unavailable `chrome.runtime` and
give a clear refresh instruction. After changing extension files, reload the
extension on `chrome://extensions` and refresh affected Boss/workbench tabs.

### Local service unavailable at first open

Cause: the browser opens `127.0.0.1:8788` before `src/server.js` has bound the
port.

Required fix: use the launcher page/script that waits for
`/api/system/version`; do not claim the extension is a health check for the
local Node service.

### Candidate state reappears after a user action

Cause: UI-only removal or using a job id where an application id is required.

Required fix: call the application status API with `application_id`, then refresh
from the persisted candidate query. Candidate queries only show `queued` and
`paused` applications.

### Historical reply distortion

Cause: assigning a final label to a whole conversation, synthetic timestamps,
or fuzzy auto-supplement records.

Required fix: store first reply events per type, preserve unknown timestamps as
unknown, use stable message dedupe keys, and exclude unlinked/legacy data from
main conversion denominators.

## 6. Local Addresses, Authentication, And Environment

- Workbench base URL: `http://127.0.0.1:8788`.
- Health/version endpoint: `GET /api/system/version`.
- Extension host permissions are limited to `https://www.zhipin.com/*` and
  `http://127.0.0.1:8788/*`.
- The local API currently has no authentication because it binds to loopback;
  do not expose it on a LAN or public interface without adding authentication
  and CSRF protections.
- Supported environment variables:
  - `WORKBENCH_DB`: override SQLite database path.
  - `CHROME_CDP_URL`: optional legacy CDP endpoint. The extension path must work
    without it.
  - `AUTOMATION_START_HOUR`, `AUTOMATION_END_HOUR`: legacy CDP automation window.
- Secrets, worker credentials, and API keys must be supplied through local
  environment configuration only. Never commit their values, `.env` files, or
  browser profile data.

## 7. Stable API Groups

This is an address map, not a full API specification.

- System: `/api/system/browser-status`, `/api/system/version`.
- Search and import: `/api/boss/search-tasks`, `/api/jobs/import`,
  `/api/jobs`, `/api/candidates`.
- Evaluation and workflow: `/api/jobs/:id/evaluate`,
  `/api/jobs/evaluate-batch`, `/api/applications/:id/mark-applied`,
  `/api/applications/:id/ignore`, `/api/applications/:id/later`.
- Reply events and history: `/api/boss/messages/sync`,
  `/api/boss/messages/history-sync`, `/api/replies/*`.
- Planning and metrics: `/api/metrics/daily`, `/api/plans/tomorrow`.

When adding an endpoint, keep it loopback-only by default and add an API-level
test for the behavior it changes.
