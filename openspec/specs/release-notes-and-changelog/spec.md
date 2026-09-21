# release-notes-and-changelog Specification

## Purpose

Define the portal's version and its change log: a hand-written `CHANGELOG.md` at the repository
root, parsed once, rendered in the portal, and the **only** place the version number lives.

## Requirements

### Requirement: The newest heading in `CHANGELOG.md` is the portal's version

#### Scenario: The portal states its version

- GIVEN the change log
- WHEN the portal's version is needed
- THEN it SHALL be the version of the newest entry
- AND there SHALL be **no** second copy of it in a package manifest for it to disagree with
- AND the reason SHALL be that a release which forgot its change log entry would otherwise ship a
  version number nobody can look up

#### Scenario: The file has no entries

- GIVEN an empty or entry-less change log
- WHEN the version is read
- THEN it SHALL fall back to `0.0.0` rather than fail to render the shell

### Requirement: Keep the change log by hand, not from git

#### Scenario: A release is prepared

- GIVEN a set of merged changes
- WHEN the change log entry is written
- THEN it SHALL be written by a person
- AND the reason SHALL be that a commit subject answers "what did we change" while a change log
  entry answers "what can you now see or do" — the two are not the same sentence, and only a person
  can write the second one

### Requirement: Parse exactly one format, and fail the build on anything else

#### Scenario: A version heading is read

- GIVEN a line of the form `## <version> - <DD.MM.YYYY>`
- WHEN it is parsed
- THEN both halves SHALL be required
- AND a pre-release suffix SHALL be kept verbatim
- AND a heading missing its date SHALL be a mistake rather than silently accepted, because it
  produces an entry the modal cannot sort

#### Scenario: A category heading is read

- GIVEN a `### <category>` heading
- WHEN it is parsed
- THEN it SHALL map to exactly one of `added`, `changed`, `fixed`, `deprecated`, `removed`
- AND anything else SHALL be rejected

#### Scenario: The prose between headings is read

- GIVEN text between a version heading and the first category
- WHEN it is parsed
- THEN it SHALL become that entry's summary

#### Scenario: The file is malformed

- GIVEN a malformed entry
- WHEN the test suite runs
- THEN it SHALL fail the build
- AND the entry SHALL NOT quietly vanish from the modal

#### Scenario: A bullet carries inline emphasis

- GIVEN a bullet or summary written with `**bold**` or `` `code` ``, which is how every entry in
  the file names a screen, a setting or a key
- WHEN it is parsed
- THEN the markers SHALL be carried through in the text and split into spans by the same module
  that defines the format, so the renderer has no second opinion about what a bullet says
- AND exactly **two** inline forms SHALL be recognised, because those are the two the file uses:
  links appear only in the preamble, which the parser never reaches
- AND matching SHALL be leftmost-first and flat — a marker with no partner SHALL stay literal, a
  marker inside a code span SHALL be part of the code, and no span SHALL be re-scanned
- AND the spans SHALL reassemble into the bullet exactly as written, so nothing is dropped or
  invented between the file and the screen

#### Scenario: The format is documented

- GIVEN `CHANGELOG.md`
- WHEN it is opened
- THEN its own preamble SHALL document the conventions the parser enforces
- AND that SHALL include the inline emphasis the dialog renders, so an author knows which markers
  reach the screen and which arrive as punctuation

### Requirement: One module reads the file

#### Scenario: The change log is needed

- GIVEN any consumer — the portal shell, the modal, a test
- WHEN the change log is read
- THEN it SHALL go through the one shared parser
- AND the browser bundle SHALL import the file as raw text, so the same source works under both the
  test runner and the production build
- AND the parse SHALL be memoised, because the file does not change while the portal is open

### Requirement: Reach the change log from the topbar

#### Scenario: The version is pressed

- GIVEN the topbar's version button
- WHEN it is activated
- THEN a modal SHALL open showing every entry, newest first, grouped by version and date
- AND the control SHALL be a **button** rather than a chip, because it answers "what changed since
  the last time I was here" and a chip that only states a number leaves that unanswered and the
  answer in a file nobody using the portal can open
- AND its accessible name SHALL include the version and what pressing it does

#### Scenario: An entry renders

- GIVEN a parsed entry
- WHEN it renders
- THEN the version and date SHALL head it, the summary SHALL follow, and each item SHALL carry a
  category badge
- AND the five badges SHALL read **New**, **Changed**, **Fixed**, **Deprecated** and **Removed**
- AND the badge classes SHALL be the ones the stylesheet already declares, chosen in the shared
  module rather than in the component, so the vocabulary and its rendering stay in one file
- AND each bullet's `**bold**` SHALL render as a `strong` element and its `` `code` `` as a `code`
  element, drawn as elements rather than through an HTML sink
- AND the reason SHALL be that the dialog rendered each bullet as one string, so every asterisk
  and backtick in the file was on screen as punctuation — on every line, since the convention is
  as old as the file — and the source being a build-time import of a repository file is not a
  reason to own an HTML sink for two markers
- AND the summary SHALL be rendered the same way as a bullet, because it is prose from the same
  file written by the same hand

#### Scenario: The modal is dismissed

- GIVEN the change log modal
- WHEN Escape or the close control is used
- THEN it SHALL close and return focus to the topbar
