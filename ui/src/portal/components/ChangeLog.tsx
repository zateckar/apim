import {
  CHANGE_LOG_TYPES,
  CHANGE_LOG_TYPE_CLASSES,
  CHANGE_LOG_TYPE_LABELS,
} from "../../../../shared/changelog";
import { changeLog } from "../../lib/changelog";
import { Modal, Notice } from "../../components";

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
              {entry.summary && <p className="changelog-summary">{entry.summary}</p>}
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
                        <span className="changelog-text">{item.text}</span>
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
