# Material viewer

The isolated `/material` surface implements the `reading/1` list/detail consumer.
It is read-only and uses only received references for local filtering. Originals
are fetched on selection, rendered as inert text and never translated by the
control-language selector. Conditions remain visible above the original; optional
reference metadata is expandable. A reference-only result is not an empty body.

Run the production build before the browser suite:

```sh
npm run build
npm run test:reading:viewer
npm run test:reading:harness
npx playwright install chromium
npm run test:reading:browser
```

The browser suite launches its own loopback server on port 3180 with synthetic
configuration and an unused local database address. It must not attach to an
already running server. `READING_BROWSER_CHANNEL=chrome` uses an installed Chrome
instead of the Playwright download, still with an isolated test browser profile.
Screenshots are written under ignored `test-results/` for visual inspection.

Positive browser cases intercept HTTP with synthetic projections. The production
viewer has no fixture imports or fallback content. An unmocked request returns
the existing service failure until the reading service is implemented. Passing
this suite is not acceptance of database persistence or server authorization.

## State and failure boundaries

- Refresh removes the previous list and detail before fetching again.
- Selection removes the previous original immediately. Both request epoch and
  selection sequence must match before a result is displayed.
- A rejected, mismatched or unusable response clears the whole material surface.
  Retry fetches a fresh list rather than reusing an old body.
- Page hiding or navigation clears the ephemeral view. Returning fetches again;
  originals are not written to browser storage.
- A new server render remounts the reader without serializing server identity.
  Server-side context and delivery checks remain required on every read. The
  viewer cannot detect an invisible server policy change by itself.

Clearing the selection on tab hide is provisional behavior for the trial, not a
permanent product requirement. It has a usability cost: switching tabs requires
selecting the document again. Its replacement must be assessed with the real
service's revalidation behavior. This step does not change that interaction.

Non-200 responses require `application/problem+json`, matching the producer.
Valid unknown Problem extensions remain ignored; an error under `application/json`
is rejected as an unusable response.

## HTTP harness safeguards

The initial-HTML assertion reads the actual enabled trial configuration and checks
subject, generation, deployment, scope and `original_text` as literal strings.
Each forbidden token is injected in a separate guard test to prove detection.
This is a directed check, not a general detector of all possible sensitive data.

Every database-trap hit records its remote address/port, timestamp and current
check label, together with the harness's active server PID. That PID identifies
the server under test, not the proven source of the connection. The trap records
no payload. A deliberately connected sentinel test proves that diagnostics are
produced and the zero-hit assertion fails.

The harness captures `.next/BUILD_ID` and its file metadata at startup and verifies
them before launches, at readiness, at request checkpoints, after server exit and
at completion. A missing or changed identity fails the run. These checks do not
lock the build directory or prove that no other artifact was modified between
checkpoints. Finish the build first and do not rebuild during test execution.

Port reservation uses an exclusive loopback bind. A competing listener fails the
reservation; after release, Next must itself bind the exact port. Readiness comes
from that owned child's output, never an arbitrary service's HTTP response. This
is not an atomic reservation handed through to Next; a competing bind must fail
startup, not cause reuse of the other process.

The browser suite still uses an unused database address rather than a counted
sentinel. It must not be cited as physical database-isolation evidence. A counted
browser/server integration check belongs to the database-backed T04/T05 work.

This step does not add publication, editing, cached answers, access requests,
background polling, authentication or the service's temporal delivery mechanism.

## Local verification record

The results below describe the initial T03 delivery. The correction pass adds
harness self-tests, explicit race variants and strict Problem media-type tests;
its executed results follow in the correction record below.

The production build and application type check passed. The controller suite
passed 10 tests, the existing reading suite passed 122 tests, and the browser
suite passed 8 tests using installed Chrome. Desktop and mobile screenshots were
visually inspected. The static import boundary also passed. Remote CI has not
run for this change.

The HTTP preparation suite passed all 22 checks with zero legacy-database trap
connections in three consecutive final runs. An earlier run recorded two trap
connections while another browser/server run was still active after a rebuild.
The cause has not been established; it is not evidence of a real database being
accessed. The counter and zero-connection assertion were not weakened. Keep this
observation visible in review and repeat the suite in clean CI.

The bundled Chromium download timed out locally, so browser checks used the
documented installed-Chrome option. Host security software injected unrelated
network activity. The inert-original test therefore asserts that the original's
specific hostile destination receives no request; it does not claim that the
host browser makes no external requests of any kind.

## Correction verification · 2026-09-09

One production build (`f0sgcBTeNiD6-7SSdkIHK`) was completed before the sequential
verification run. No rebuild was started during these checks.

| Check | Result |
|---|---|
| Harness guard suite | 11 passed: valid HTML control, five injected tokens, changed/missing/rewritten build identity, occupied port, intentional trap connection |
| Viewer controller suite | 16 passed, including explicit A-to-B-to-A, late refusal, refresh-during-detail and late-list-failure cases |
| Existing reading suite | 122 passed; experimental temporal limitations remain reported, not converted into conformity |
| Application type check | Passed |
| HTTP preparation harness | Two sequential runs: 22 checks each, zero trap hits, build identity unchanged |
| Browser suite | 8 passed with installed Chrome, against the completed production build |
| Static reading import boundary | Passed, 105 modules inspected |
| Whitespace check | Passed |
| Remote CI | Not run at this local verification checkpoint |

The controller now rejects errors under the wrong media type without rejecting
valid unknown Problem extensions. Its added tests also reject HTTP/body status
disagreement. The visual component, scoped styling and tab-hide behavior were not
changed in this correction pass.

ADR-030 now follows the repository header with proposed status and a pending
decision date. Acceptance is not manufactured by an implementation change.
The reading CI budget is 20 minutes; browser retries remain zero. Browser binary
caching is deferred as an unmeasured optimization, not a merge prerequisite.

The earlier two trap connections remain unexplained. The new diagnostics improve
future attribution but cannot retroactively identify their source. The browser
suite's lack of a counted trap remains a stated limit assigned to database-backed
integration; its successful mocked reads are not physical-isolation evidence.

Before publication, the HTTP harness's subject and generation were changed to
longer distinctive synthetic literals to reduce accidental substring matches in
the HTML guard. The same values are exercised in the guard tests. All 11 guard
tests and the 22 HTTP checks passed again, with zero trap connections and unchanged
build identity. No production behavior changed in this final test-data adjustment.
