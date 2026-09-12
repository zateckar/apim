# frontend-visual-system Specification

## Purpose

Define the visual language and the interface rules that are enforced rather than reviewed: one
colour vocabulary, one status vocabulary, one date format, and a set of structural properties that
`ui/test/hygiene.test.ts` asserts over the source. See *Visual Identity Summary*, *The Status
Vocabulary* and *Interface House Rules* in `openspec/project.md`.

## Requirements

### Requirement: Define colour once, as tokens, in two schemes

#### Scenario: A colour is needed

- GIVEN any surface, border, text or state colour
- WHEN it is used
- THEN it SHALL come from a custom property in `ui/src/portal/brand.css`
- AND the palette SHALL be defined in `oklch`, with a light set and a dark set of the same names,
  so a theme switch changes tokens rather than rules

#### Scenario: The token set is enumerated

- GIVEN the stylesheet
- WHEN the tokens are read
- THEN they SHALL include `--bg` / `--bg-subtle` / `--bg-muted`, `--surface` / `--surface-raised`,
  `--border` / `--border-strong`, `--fg` / `--fg-muted` / `--fg-subtle` / `--fg-faint`,
  `--accent` with `-hover`, `-soft`, `-fg` and `-ring`, and the state families `--ok`, `--warn`,
  `--err`, `--info` and `--violet`, each with a `-soft` companion
- AND the accent SHALL resolve to the brand green in light and to the light brand green in dark, so
  contrast is preserved without a second rule

#### Scenario: A view names a colour directly

- GIVEN any `.tsx` file under `ui/src`
- WHEN it is scanned
- THEN it SHALL contain no `#rrggbb` literal
- AND the reason SHALL be that a hex literal in a view is a status colour that means something on
  one screen and nothing on the next

### Requirement: Use two self-hosted typefaces and nothing else

#### Scenario: Text is rendered

- GIVEN any text
- WHEN it is styled
- THEN it SHALL use `--font-sans` (Inter Tight, with a system stack behind it) or `--font-mono`
  (JetBrains Mono)
- AND identifiers, digests, keys, paths and LeanIX ids SHALL use the monospace family, so a value
  a reader may need to copy is visually distinguishable from prose

### Requirement: Keep the branded sidebar and its geometry

#### Scenario: The shell renders

- GIVEN the portal
- WHEN the sidebar renders
- THEN it SHALL be a neutral surface matching the selected theme, with a subtle right border, a dark-green brand row aligned with the topbar, grouped navigation sections and a
  user footer
- AND the selected navigation entry SHALL use a mint fill and dark-green text; every navigation label SHALL have a meaningful outline icon declared in the route table
- AND the application picker and environment switcher SHALL use compact rounded controls with a
  clearly marked selection

#### Scenario: An application card is rendered

- GIVEN an application with a LeanIX id
- WHEN it is rendered in the picker
- THEN the name SHALL be the primary line and the LeanIX id a monospace subline
- AND no environment subline SHALL be shown, because the environment is the page head's switcher
  and two places to read it is two places to disagree

### Requirement: Use one closed tone vocabulary for state

#### Scenario: A state is shown

- GIVEN any lifecycle, release, operation, subscription, Kafka topic, Kafka grant, integration
  event or instance state
- WHEN it is rendered as a chip
- THEN the label and the tone SHALL come from `ui/src/lib/status.ts`, drawn by `StatusChip`
- AND the tone SHALL be one of `live`, `wait`, `stop`, `past`, `warn`, `neutral`
- AND the underlying column value SHALL remain available as the chip's `title`, so nobody debugging
  is left guessing what it maps to
- AND there SHALL be exactly one chip producer: no component may take a raw state string and choose
  a class from it

#### Scenario: A state is named for the reader, not for the column

- GIVEN a state whose column value is the machine's phrasing — `waiting-for-gateways`, `converged`,
  `provisioning`
- WHEN it renders
- THEN the label SHALL say what it means to the reader — *Rolling out*, *Live*, *Creating*
- AND the label SHALL NOT be the column value with the hyphens swapped for spaces
- AND the reason SHALL be that a reader watching their own change go out is asking "is it out there
  yet", and `waiting for gateways` answers a question the reconciler asked, not the one they did

#### Scenario: A state has no news

- GIVEN a lifecycle of `active`
- WHEN it renders
- THEN **no chip** SHALL be shown
- AND the reason SHALL be that a chip on every row means nothing

#### Scenario: A state nobody has decided yet

- GIVEN a subscription or Kafka grant that is `pending`, or an integration event that is
  `awaiting-decision`
- WHEN it renders
- THEN its tone SHALL be `wait`, never `stop`
- AND the reason SHALL be that a request still sitting in its publisher's queue is not a request
  that was refused, and colouring it as one tells the consumer they were turned down

#### Scenario: A new state is added

- GIVEN a new value in any status domain
- WHEN the test suite runs
- THEN the vocabulary SHALL be asserted **total** over `STATUS_DOMAINS`, so a state cannot ship
  without a word for it
- AND each domain's states SHALL be declared as an iterable `as const` list in `shared/types.ts`,
  because a list that cannot be iterated cannot be checked for totality

#### Scenario: A view names a tone class

- GIVEN a `tone-<name>` class in a view or a lib module
- WHEN the source is scanned
- THEN that tone SHALL exist in the stylesheet

### Requirement: Make every interactive thing reachable from a keyboard

#### Scenario: A clickable element is written

- GIVEN any `onClick` in a `.tsx` file
- WHEN the source is scanned
- THEN its owning tag SHALL be `button`, `a`, or a capitalised component
- AND the reason SHALL be that a `<div onClick>` looks like a control to a person with a mouse and
  does not exist to anybody else

#### Scenario: A toolbar button must not steal the caret

- GIVEN a control that acts on a focused text field, such as the Markdown editor's toolbar
- WHEN it is pressed with a mouse
- THEN the default mouse-down SHALL be prevented so the caret is preserved, and the action SHALL
  run on click
- AND the control SHALL remain a real `button`, so Enter and Space still activate it

### Requirement: Keep one shared component vocabulary

#### Scenario: A screen needs a shared component

- GIVEN any screen, in the branded shell or in a `plainChrome` view
- WHEN it needs a banner, an empty state, a labelled field, a section, a modal or an async-action
  hook
- THEN it SHALL import it from `ui/src/components.tsx`
- AND there SHALL be exactly one shared component module, so which components a screen gets is not
  decided by which file it happens to import
- AND the reason SHALL be that there were two — `ui/src/components.tsx` and
  `ui/src/portal/common.tsx` — with four pairs that overlapped and were not interchangeable, so two
  screens showing the same kind of thing looked and behaved differently

#### Scenario: Two components under one name are reconciled

- GIVEN two components that did the same job under the same name
- WHEN they are merged
- THEN one name SHALL survive per concept: `Notice` for every banner, `EmptyState` for every empty
  state, `useAction` for every async action, `Field` for a labelled slot, `Panel` for every titled
  section of a screen
- AND a genuinely different component SHALL get a **different name** rather than a merged prop set —
  `TextField`, the labelled text input, is not the labelled slot and never was
- AND `Notice` SHALL render the themed `.banner` tones, with `role="alert"` on an error

#### Scenario: A section of a screen is drawn

- GIVEN any titled section, in the branded shell or in a `plainChrome` view
- WHEN it renders
- THEN it SHALL be a `Panel`, and its shape SHALL be `.card` › optional `.card-head` › `.card-body`
- AND the outer `.card` SHALL carry no padding of its own, so the head's rule reaches both edges of
  the section it divides
- AND a section whose body should reach those edges — a table, a list of rows — SHALL say so with
  `flush` rather than an inline `padding: 0`
- AND the reason SHALL be that there were two section components under two names and two shapes:
  `Panel` wrapped its children in a head and a body, `Card` put them straight into `.card`, and
  because both bare selectors were global and both stylesheets loaded, the padding `Card` needed
  landed on **every** `Panel` as well — insetting each head's bottom rule twenty pixels from the
  card it was drawn to divide, invisibly, under `overflow: hidden`

#### Scenario: A screen writes a shared class directly

- GIVEN a `className` naming `empty`, `notice`, `banner`, `card`, `card-head` or `card-body` in any
  file other than the component module itself
- WHEN the source is scanned
- THEN it SHALL fail
- AND the reason SHALL be that this is how a second vocabulary grows back: not by adding a module,
  but by one screen writing the box itself and escaping every rule attached to the component

### Requirement: Never end a first visit at a dead end

#### Scenario: A list is empty

- GIVEN any `<EmptyState>`
- WHEN the source is scanned
- THEN it SHALL carry an `action`
- AND the reason SHALL be that an empty state with no next step is where a first visit ends
- AND the rule SHALL cover the **whole** interface: there SHALL be no second empty-state component
  that takes bare children and carries no action

#### Scenario: Something that is not an empty state was written as one

- GIVEN a box that says a request has not answered yet, or explains why a control cannot be used
- WHEN it is reviewed
- THEN it SHALL be a `Skeleton` or a `Notice` respectively, not an `EmptyState`
- AND the reason SHALL be that neither has a next action, and inventing one to satisfy the rule
  would be worse than the dead end the rule is about

### Requirement: Confirm a destructive action by typing the object's name

#### Scenario: Something destructive is offered

- GIVEN any deletion of a named object
- WHEN the control is rendered
- THEN it SHALL sit inside a typed confirmation, and the object's name SHALL have to be typed back
- AND `confirm()` SHALL NOT be used anywhere, because it says "Are you sure?" and nothing else — no
  consequence, no object name, and one stray Return away from a deletion

#### Scenario: A delete is not the removal of a named object

- GIVEN a delete that removes a record rather than a thing anybody depends on — one entry of the
  caller's own console history, a policy unit that re-attaches with the same click, one of the
  caller's own sessions, a signed-out session, a revoked membership the button beside it grants
  back, or a wizard undoing its own half-completed step
- WHEN the source is scanned
- THEN it SHALL be listed as an explicit exemption with the reason recorded beside it
- AND an exemption that no longer matches anything SHALL fail the suite, because it is an exemption
  nobody is checking
- AND any delete that is neither in a typed confirmation nor exempt SHALL fail the suite

### Requirement: Render every error where it happened

#### Scenario: A request can fail

- GIVEN any `useAsync` or `useAction` binding
- WHEN the source is scanned
- THEN either this file SHALL read its `.error`, or it SHALL hand the whole handle to a child that
  does
- AND the reason SHALL be that an unread error fails silently — a spinner that stops, or a button
  that does nothing when pressed

### Requirement: Use one button hierarchy, with red reserved

#### Scenario: An action is rendered

- GIVEN a screen with several actions
- WHEN they render
- THEN there SHALL be at most one primary action, ghost buttons for the rest, and a small variant
  for controls inside rows and headers
- AND red SHALL be reserved for destructive actions; Cancel and Close SHALL hover neutrally, so a red control always means
  the same thing

#### Scenario: A signature action is rendered

- GIVEN a publish or a new-version action
- WHEN it renders
- THEN it SHALL use the same mint-filled, dark-green-text primary button as other committing actions

#### Scenario: A button written in the older vocabulary is rendered

- GIVEN a screen under `views/`, written with `button`, `button.ghost`, `button.danger` or
  `button.small` rather than with `.btn`
- WHEN it renders inside the branded shell
- THEN it SHALL still carry the shell's button chrome — a border, a background and padding
- AND the reason SHALL be that `brand.css` resets every `button` to none of those, because the shell
  builds its nav items, tabs, card heads and icon buttons out of bare elements; `styles.css` loads
  first, so the reset won every tie and sixteen of the routes drew their buttons as flat text
  indistinguishable from the sentence above them
- AND the restoration SHALL name those four selectors exactly rather than match "every button that
  is not a `.btn`", because the facets, the status chips and the fold headers are buttons that carry
  their own chrome, and a `:not()` list of everything to be spared goes silently wrong as screens
  are added
- AND it SHALL NOT restore emphasis with the chrome: a bare `button` was the accent-filled primary
  in the older vocabulary, and a form carrying six of those would contradict the one-primary rule
  above, so the base is neutral and a screen promotes its dominant action explicitly

#### Scenario: A control that operates nothing is rendered

- GIVEN a value the reader cannot change — a version picker with one version, a count, a state
- WHEN it renders
- THEN it SHALL NOT be a `label`, a `select` or a button
- AND the reason SHALL be that each of those is a promise of something to operate, and a reader who
  accepts the promise and finds nothing there concludes the control is broken rather than that the
  choice does not exist

### Requirement: Use one form-field shape and one editor

#### Scenario: A field is rendered

- GIVEN any labelled input, select or textarea
- WHEN it renders
- THEN it SHALL carry a label above the control, an optional helper line beneath it, and the
  compact rounded rectangular geometry of the shared stylesheet
- AND a read-only field SHALL be visibly disabled with the reason nearby rather than removed
- AND the label SHALL **name** its control — wrapping it, or carrying `htmlFor` against the
  control's id — rather than merely sitting above it, which announces an unlabelled box

#### Scenario: A description is edited

- GIVEN any long-form description field
- WHEN it renders
- THEN it SHALL use the shared Markdown editor: a source textarea with a formatting toolbar and a
  **Preview** that renders through the same component readers see
- AND the editor SHALL be dependency-free, with the textarea as the source of truth, so there is no
  serialization round trip to lose formatting in
- AND its label SHALL NOT be a `<label>` wrapper, which would forward every toolbar press to the
  textarea as a second activation

#### Scenario: A definition is edited

- GIVEN an API definition or a policy document
- WHEN it renders
- THEN it SHALL use CodeMirror with a light theme and a fixed configuration, bordered and
  monospaced, so schema editing looks the same on every screen that offers it

### Requirement: Make a modal deliberate and wide

#### Scenario: A modal is open

- GIVEN any modal
- WHEN it renders
- THEN it SHALL be wide enough for the content it carries rather than a fixed narrow dialog
- AND Escape and an explicit close control SHALL both dismiss it
- AND dismissal SHALL be deliberate: a stray click SHALL NOT discard unsaved work

### Requirement: Draw icons inline

#### Scenario: An icon is needed

- GIVEN any icon
- WHEN it renders
- THEN it SHALL be an inline SVG from the portal's own icon module, taking `currentColor`
- AND no icon font SHALL be loaded

### Requirement: Respect a reduced-motion preference

#### Scenario: The reader prefers reduced motion

- GIVEN `prefers-reduced-motion: reduce`
- WHEN the portal renders
- THEN transitions and skeleton shimmer animations SHALL be suppressed

### Requirement: Say when a result is simulated

#### Scenario: A screen shows data from a mocked system

- GIVEN a result from a simulated external system, or from the mock log provider
- WHEN it renders
- THEN the screen SHALL say it is simulated, in words, beside the result
- AND the topbar SHALL additionally carry a standing chip while any surrounding system is simulated

### Requirement: Keep all screens compact and readable in both themes

#### Scenario: A shared surface renders

- GIVEN a list, form, dashboard, health card or administration screen
- WHEN it renders in either theme
- THEN panels SHALL use 16px body padding, compact section headers, subtle borders and neutral surfaces
- AND status fills SHALL be soft tints with readable state text; health verdicts SHALL retain explicit labels
- AND primary actions SHALL use the accent fill with contrasting text in both idle and hover states
- AND dashboard helper text SHALL use sentence case rather than all capitals
- AND legacy colour and font tokens SHALL resolve to the same theme tokens as branded components
- AND commonly used field labels, workspace tabs and table values SHALL be at least 14px, with secondary metadata at least 12px in the shared page chrome
- AND unread mail SHALL use a subtle background, a leading dot and stronger subject text instead of a saturated row fill
- AND uptime charts SHALL use neutral surfaces with theme-aware axes, lines and status marks
- AND numeric table columns SHALL retain right alignment in both screen vocabularies

#### Scenario: Controls govern the content below them

- GIVEN a dashboard or telemetry time-range control
- WHEN the page renders
- THEN it SHALL appear above the values it governs in a compact toolbar
- AND toolbar controls SHALL wrap together on a narrow screen without stretching a select across the whole desktop page

#### Scenario: A table or identifier exceeds its container

- GIVEN a narrow viewport or a long identifier
- WHEN a page renders
- THEN tables SHALL scroll within their panel and identifiers SHALL wrap within available space
- AND the page itself SHALL NOT require horizontal scrolling
- AND workspace and trust tabs SHALL remain reachable by horizontal scrolling

#### Scenario: A timestamp is rendered in an older screen

- GIVEN an account, membership, certificate, policy, gateway, playground-history or audit timestamp
- WHEN it is displayed
- THEN it SHALL use the shared date or date-time formatter
- AND an audit timestamp SHALL include the date, so events on separate days are distinguishable

#### Scenario: The application picker is operated from the keyboard

- GIVEN the picker is open
- WHEN the user presses Up, Down, Home or End on an option
- THEN focus SHALL move between available applications
- AND Escape or selecting an option SHALL return focus to the trigger
