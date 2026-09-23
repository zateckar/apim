# notifications-and-mail Specification

## Purpose

Define the notifications bell and the Mail screen: **one query with two renderings**, read from the
email outbox rather than from a second table. The bell shows headlines and a link to the screen that
acts on each; the mailbox shows the message.

## Requirements

### Requirement: The feed is the email outbox, not a second list

#### Scenario: The feed is built

- GIVEN business events that already emit an email
- WHEN the notification feed is built
- THEN it SHALL be read from `integration_event` where the integration is `email`
- AND there SHALL be no parallel notification table
- AND the reason SHALL be that a second list of the same facts is free to disagree with the one
  that was actually sent, and the first bug would be a bell that says something the mailbox does not

#### Scenario: A new kind of event appears

- GIVEN an outbox `kind` the portal has no title for
- WHEN it renders
- THEN it SHALL still be shown, as its own subject
- AND the feed SHALL therefore never silently drop something that was sent

### Requirement: Name what happened in the reader's terms

#### Scenario: A known kind renders

- GIVEN one of the known kinds
- WHEN its title is composed
- THEN it SHALL read as a sentence about the reader — "You requested access to X", "Someone is
  asking for access to X", "Your access to X was approved", "Your request for X was turned down",
  "Access to X is active", "Access to X was withdrawn"
- AND the subject SHALL be resolved to the thing's real name rather than shown as an id

#### Scenario: A tone is assigned

- GIVEN a notification
- WHEN it renders
- THEN it SHALL carry one of `ok`, `warn`, `err`, `info`
- AND an approval SHALL be `ok`, a rejection `err`, a request awaiting the reader's decision `warn`,
  and a purely informational item `info`

#### Scenario: There is something to do about it

- GIVEN a notification whose subject can be acted on
- WHEN it renders
- THEN it SHALL link to the screen that acts on it
- AND a notification with nothing to do but know SHALL carry no link rather than a link to nowhere

### Requirement: What is read lives in the reader's browser

#### Scenario: A notification is read

- GIVEN a reader who opens the bell
- WHEN the items are seen
- THEN they SHALL be marked read in that person's browser
- AND the control plane SHALL store nothing about it and SHALL have no opinion
- AND the reason SHALL be that "read" is a property of one person's eyes rather than of the estate

#### Scenario: The same person has two tabs open

- GIVEN two tabs of the portal
- WHEN one of them marks items read
- THEN the other SHALL update too
- AND the reason SHALL be that the browser's cross-tab storage event does not fire in the tab that
  wrote it, so a same-tab signal is needed as well

#### Scenario: The read set grows without bound

- GIVEN a long-lived browser
- WHEN read ids accumulate
- THEN only a bounded number of the most recent SHALL be remembered

### Requirement: The bell counts unread, and answers a different question from the activity count

#### Scenario: The topbar renders

- GIVEN unread notifications and operations in flight
- WHEN the topbar renders
- THEN the bell SHALL show the count of **unread** notifications
- AND the activity control SHALL separately show the count of operations that are neither complete
  nor superseded, linking to Activity
- AND the two SHALL be understood as different questions: "what happened that I have not seen"
  versus "what is being deployed right now"

#### Scenario: The bell is opened

- GIVEN the bell
- WHEN it is activated
- THEN a popover SHALL list the most recent items, unread ones distinguished, each with its tone,
  its title, its age and its link
- AND Escape and a click outside SHALL both close it, and so SHALL following a link inside it
- AND opening the mailbox from it SHALL be a link, not a button that navigates
- AND there SHALL be no parallel toast stack

#### Scenario: The feed is polled

- GIVEN the portal open
- WHEN time passes
- THEN the feed SHALL be re-read on a modest interval
- AND the bound on how many items are fetched SHALL be clamped on the server

### Requirement: Mail is a screen in its own right

#### Scenario: The Mail section is opened

- GIVEN the sidebar's untitled first group, beside Dashboard and Activity
- WHEN Mail is opened
- THEN every message for the selected application SHALL be listed with its recipients, its subject,
  its body, when it was sent and whether it has been sent yet
- AND the section's head SHALL say how many are unread rather than repeat the application's name,
  which the picker and the page head already show
- AND a message SHALL NOT show its outbox `kind`, because the subject already says it in words
- AND a message with a related screen SHALL link to it
- AND the reason it is navigable SHALL be that "what was that mail about" is a question people
  arrive with, not one they only ever reach by opening a popover first

#### Scenario: A message has not been sent yet

- GIVEN an event in `queued` or `retrying`
- WHEN it renders
- THEN it SHALL be shown as not sent yet, distinguishable from `delivered`, which SHALL read *Sent*

#### Scenario: The feed has not answered yet

- GIVEN the bell's popover or the Mail section, before the first read of the feed has returned
- WHEN it renders
- THEN it SHALL show a loading placeholder rather than the empty state
- AND the reason SHALL be that "No mail yet" for as long as the request took was a false answer to
  somebody who had mail

### Requirement: Scope the feed to what the caller may read

#### Scenario: The feed is requested

- GIVEN a signed-in user
- WHEN they read notifications
- THEN they SHALL see items for their own applications, or all of them if they are an administrator
- AND naming an application they may not read SHALL be refused

### Requirement: Say the transport is simulated, and that the events are not

#### Scenario: An item renders

- GIVEN any notification
- WHEN it renders
- THEN it SHALL be marked simulated, because the message was composed and never handed to a mail
  server
- AND the **events** SHALL be understood as real: emitted by real decisions, and surviving a restart
