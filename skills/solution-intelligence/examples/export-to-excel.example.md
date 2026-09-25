# Solution Analysis — Export report to Excel

> Worked example (feature pipeline) focused on **opportunity vs over-engineering**: finding something better *without* building a framework nobody asked for.

## 1. Request (context-discovery)

REQUEST (restated)
Add the ability to export a report as an Excel file.

TYPE: feature

CURRENT CONTEXT
- Reporting module currently renders reports to HTML only.
- Excel generation is hard-coded into the report service (no abstraction).
- No roadmap item for other export formats.

CONSUMERS AFFECTED
- Users who download reports; report module maintainers.

UNKNOWNS / QUESTIONS TO RESOLVE
1. Is there any planned need for PDF/CSV/JSON export?

## 2. Gaps & Hidden Impacts (gap-analysis)

| Class | Lens | Finding | Consequence if ignored |
|-------|------|---------|------------------------|
| GAP | Requirement | Export trigger UX (button? API?) unspecified | Ambiguous endpoint |
| RISK | Data | Large reports may OOM if rendered fully in memory | Crash on big exports |
| RISK | Security | Exported file may leak data not shown in HTML view | Over-exposure |
| OPPORTUNITY | Architecture | Split `ReportDataModel` from `ExcelRenderer` | Enables other formats cheaply later |
| OVER-ENGINEERING | Architecture | Generic `ExportProvider` plugin framework now | No 2nd consumer yet |

OVER-ENGINEERING WATCHLIST
- Full ExportProvider plugin framework — build it when a second format actually appears.

## 4. Alternatives (solution-exploration)

A. Hard-code Excel export (minimal)
   + fastest   − locks format in; re-render logic duplicated
   over-engineering verdict: ok, but leaves the duplicate.

B. Split ReportDataModel → ExcelRenderer (recommended)
   + one data model, many renderers later   − small refactor now
   over-engineering verdict: ok — one concrete consumer (Excel), small cost.

C. Generic ExportProvider framework
   + "any format, any time"   − no 2nd consumer; speculative
   over-engineering verdict: yes — over-engineering for today.

OPPORTUNITIES FOUND
- The DataModel/Renderer split — value: future formats reuse the model; cost: small; risk: none; relevance: direct.

EXPLICITLY NOT DOING (for now)
- PDF/CSV/JSON renderers, plugin registration system.

## 5. Trade-offs (tradeoff-analysis)

RECOMMENDATION
B — separate `ReportDataModel` from `ExcelRenderer`, do **not** create a generic plugin framework.
WHY: gets the requested feature with clean structure; defers the framework until a second concrete format is demanded.
WHAT WE GIVE UP: instant "plug in any format" capability (not needed today).

## 6. Scope Boundary (scope-control)

MUST
- Excel export endpoint + correct column mapping + streaming for large reports.

SHOULD
- Reuse the existing report query path (no duplicated query logic).

COULD
- Export button in the report UI.

NOT NOW
- PDF/CSV/JSON exporters; ExportProvider plugin framework.

## 7. Verification Plan (verification-planning)

| Scenario | Expected result | How | Closes |
|----------|-----------------|-----|--------|
| happy path | valid .xlsx with correct data | integration | — |
| large report | export streams, no OOM | integration | RISK-OOM |
| permission | export honors same access as HTML view | integration | RISK-leak |
| regression | HTML view unchanged | e2e | — |
