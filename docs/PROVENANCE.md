# Provenance

This repository was initialised on **21 August 2026**. Its commit history starts on that date; nothing in it is retro-dated.

The project's design and specification work predates the repository: a documentary record (requirements, specification, sources register, plan and decision log) has been maintained offline since **13 August 2026**, and is curated into this repository's documents as they are prepared for delivery. Where a document in `docs/` or `registro/` captures a decision taken before repository initialisation, its header states the decision date; the commit date records when it entered the repository.

## Retained source and import records

This index points to existing manifests; it is not a new certification of all repository
dependencies or historical sources. Source dates, byte counts and digests remain in each
manifest rather than being reconstructed from the current checkout date.

| Material | Record | Scope and attribution |
|---|---|---|
| Historical synthetic reading schema and examples, copied 8 September 2026 | [Reading source manifest](../tests/contracts/T02_sources/provenance.json) | Byte-identical design evidence mapped to English `reading/1`; not runtime data, a wire adapter or service observations |
| Reviewed intake experiment copied into tests | [Intake copy manifest](../tests/intake/t01/PROVENANCE.json) | Identifies copied files and their exact bytes; copying does not adopt an operational profile or authenticate provenance |
| SheetJS CE 0.20.3 archive, obtained 11 September 2026 | [Vendor provenance](../tests/intake/t01/reviewed/vendor/provenance.json) | Apache-2.0; official CDN source, size, SHA-256 and package integrity recorded; no independent publisher signature was available |

Preserve third-party licenses and notices with their material. A digest establishes byte
integrity against its reference, not authority or authentic origin by itself. The reading
fixtures are authored expectations; the intake manifest is copy evidence. Neither is a
substitute for the identified executions in the [delivery records](README.md).
