import { Fragment } from "react";
import {
  CHANGE_LOG_TYPES,
  CHANGE_LOG_TYPE_CLASSES,
  CHANGE_LOG_TYPE_LABELS,
  inlineSpans,
} from "../../../../shared/changelog";
import { changeLog } from "../../lib/changelog";
import { Modal, Notice } from "../../components";

/**
 * A line of the change log, with its emphasis.
 *
 * `CHANGELOG.md` is Markdown and every entry in it names screens in `**bold**` and settings and
 * keys in `` `code` ``. Rendered as one string, all of that arrived as visible asterisks and
 * backticks — on every line of the dialog, since the convention is as old as the file.
 *
 * Tokenised in JSX rather than through `dangerouslySetInnerHTML`. The source is a build-time
 * `?raw` import of a file in this repository, so there is no untrusted input here today; an HTML
 * sink is still a thing a later change could feed, and two markers are not worth owning one.
 * Anything the tokeniser does not recognise stays exactly as written.
 */
function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineSpans(text).map((span, index) =>
        span.kind === "strong" ? (
          <strong key={index}>{span.text}</strong>
        ) : span.kind === "code" ? (
          <code key={index}>{span.text}</code>
        ) : (
          // A fragment, not a `span`: plain text needs no element, and adding one would put a box
          // between the emphasis and the words either side of it for the stylesheet to catch.
          <Fragment key={index}>{span.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * The portal's own release notes, opened from the version in the top bar.
 *
 * Grouped by version and then by category in a fixed order — new things, then deliberate changes,
 * then fixes, then what is going away — so a reader scanning for "what can I do now that I could
 * not on Friday" reads the top of each entry and stops. The order is the constant, not the file's:
 * a version whose author wrote Fixed before Added still renders the same way.
 */
export function ChangeLog({ close }: { close: () => void }) {
  const entries = changeLog();
  return (
    <Modal title="What changed in the portal" close={close}>
      {entries.length === 0 ? (
        // Not an empty state: there is no action a reader of the portal can take about a change
        // log nobody has written. It is a warning that a file the build reads came back empty.
        <Notice kind="warn">
          The change log is empty. Entries are written into CHANGELOG.md at the repository root.
        </Notice>
      ) : (
        <div className="changelog">
          {entries.map((entry) => (
            <section className="changelog-entry" key={entry.version}>
              <header className="changelog-entry-head">
                <span className="changelog-version">v{entry.version}</span>
                <span className="changelog-date">{entry.date}</span>
              </header>
              {/* The summary is prose from the same file by the same hand, so it reads the same
                  way. No summary uses a marker today; the next one that does should not have to
                  discover that only bullets were wired up. */}
              {entry.summary && (
                <p className="changelog-summary">
                  <Inline text={entry.summary} />
                </p>
              )}
              {CHANGE_LOG_TYPES.map((type) => {
                const items = entry.items.filter((item) => item.type === type);
                if (items.length === 0) return null;
                return (
                  <ul className="changelog-items" key={type}>
                    {items.map((item, index) => (
                      <li className="changelog-item" key={index}>
                        <span className={`changelog-tag ${CHANGE_LOG_TYPE_CLASSES[type]}`}>
                          {CHANGE_LOG_TYPE_LABELS[type]}
                        </span>
                        <span className="changelog-text">
                          <Inline text={item.text} />
                        </span>
                      </li>
                    ))}
                  </ul>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
